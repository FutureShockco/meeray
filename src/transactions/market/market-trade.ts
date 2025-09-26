import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { getTokenDecimals, toBigInt } from '../../utils/bigint.js';
import { calculateExpectedAMMOutput } from '../../utils/pool.js';
import { determineOrderSide, findTradingPairId, recordAMMTrade } from '../../utils/trade.js';
import validate from '../../validation/index.js';
import { OrderSide, OrderType, createOrder, isAlignedToLotSize, isAlignedToTickSize } from '../market/market-interfaces.js';
import { matchingEngine } from '../market/matching-engine.js';
import { PoolSwapResult } from '../pool/pool-interfaces.js';
import { processWithResult } from '../pool/pool-processor.js';
import * as poolSwap from '../pool/pool-swap.js';
import { liquidityAggregator } from './market-aggregator.js';
import { HybridRoute, HybridTradeData, HybridTradeResult } from './market-interfaces.js';

export async function validateTx(data: HybridTradeData, sender: string): Promise<boolean> {
    try {
        if (!data.tokenIn || !data.tokenOut || data.amountIn === undefined) {
            logger.warn('[hybrid-trade] Invalid data: Missing required fields (tokenIn, tokenOut, amountIn).');
            return false;
        }
        if (!validate.tokenSymbols([data.tokenIn, data.tokenOut])) {
            logger.warn('[hybrid-trade] Invalid token symbols.');
            return false;
        }
        if (data.tokenIn === data.tokenOut) {
            logger.warn('[hybrid-trade] Cannot trade the same token.');
            return false;
        }
        if (!(await validate.tokenExists(data.tokenIn)) || !(await validate.tokenExists(data.tokenOut))) {
            logger.warn('[hybrid-trade] Invalid token symbols.');
            return false;
        }
        if (toBigInt(data.amountIn) <= toBigInt(0)) {
            logger.warn('[hybrid-trade] amountIn must be positive.');
            return false;
        }

        // Validate slippage protection vs price specification
        // Consider a price present if the top-level trade provides one OR any ORDERBOOK route has a price specified
        let hasPrice = data.price !== undefined;
        if (!hasPrice && data.routes && data.routes.length > 0) {
            for (const route of data.routes) {
                try {
                    if (route.type === 'ORDERBOOK') {
                        const obDetails: any = route.details || {};
                        if (obDetails.price !== undefined) {
                            hasPrice = true;
                            break;
                        }
                    }
                } catch (err) {
                    // ignore and continue
                }
            }
        }
        const hasMinAmountOut = data.minAmountOut !== undefined;
        const hasMaxSlippage = data.maxSlippagePercent !== undefined;

        if (hasPrice && (hasMinAmountOut || hasMaxSlippage)) {
            logger.warn(
                '[hybrid-trade] Cannot specify price together with slippage protection (minAmountOut or maxSlippagePercent). Choose either specific price or slippage protection.'
            );
            return false;
        }

        if (!hasPrice && !hasMinAmountOut && !hasMaxSlippage) {
            logger.warn(
                '[hybrid-trade] Must specify either price, minAmountOut, or maxSlippagePercent. For market orders, maxSlippagePercent is recommended for better user experience.'
            );
            return false;
        }

        if (hasMinAmountOut && hasMaxSlippage) {
            logger.warn('[hybrid-trade] Cannot specify both minAmountOut and maxSlippagePercent. Choose one slippage protection method.');
            return false;
        }

        // For market orders (no specific price), prefer maxSlippagePercent over minAmountOut
        if (!hasPrice && hasMinAmountOut && !hasMaxSlippage) {
            logger.info(
                '[hybrid-trade] Using minAmountOut for market order. If AMM output is below this threshold, the trade will be routed to orderbook as a limit order for better price protection.'
            );
        }

        if (hasPrice && toBigInt(data.price!) <= toBigInt(0)) {
            logger.warn('[hybrid-trade] price must be positive.');
            return false;
        }

        if (hasMinAmountOut && toBigInt(data.minAmountOut!) < toBigInt(0)) {
            logger.warn('[hybrid-trade] minAmountOut cannot be negative.');
            return false;
        }

        if (hasMinAmountOut) {
            const amountIn = toBigInt(data.amountIn);
            const minAmountOut = toBigInt(data.minAmountOut!);

            // Only warn for extremely unusual ratios (more than 10^20 to catch obvious errors)
            // But still allow the transaction - different token decimals can create huge legitimate ratios
            if (minAmountOut > amountIn * toBigInt(10) ** toBigInt(20)) {
                logger.warn(
                    `[hybrid-trade] minAmountOut ${minAmountOut} is unusually high compared to input amount ${amountIn}. Please verify this is correct.`
                );
            }
        }

        if (hasMaxSlippage && (data.maxSlippagePercent! < 0 || data.maxSlippagePercent! > 100)) {
            logger.warn('[hybrid-trade] maxSlippagePercent must be between 0 and 100.');
            return false;
        }

        const senderAccount = await getAccount(sender);
        if (!senderAccount) {
            logger.warn(`[hybrid-trade] Sender account ${sender} not found.`);
            return false;
        }

        const tokenInBalance = toBigInt((senderAccount!.balances && senderAccount!.balances[data.tokenIn]) || '0');
        if (tokenInBalance < toBigInt(data.amountIn)) {
            logger.warn(`[hybrid-trade] Insufficient balance for ${data.tokenIn}. Required: ${data.amountIn}, Available: ${tokenInBalance}`);
            return false;
        }

        // Additional route-level validation: ensure user has sufficient funds for ORDERBOOK routes
        // (especially important for ORDERBOOK BUY where the deducted token may be the quote token)
        if (data.routes && data.routes.length > 0) {
            for (const route of data.routes) {
                if (route.type !== 'ORDERBOOK') continue;
                try {
                    const obDetails = route.details as any;
                    const pair = await cache.findOnePromise('tradingPairs', { _id: obDetails.pairId });
                    if (!pair) {
                        logger.warn(`[hybrid-trade] Validation: Trading pair ${obDetails.pairId} not found for route.`);
                        return false;
                    }

                    // Determine side (prefer server-side determination when possible)
                    let side: any = obDetails.side;
                    if (!side) {
                        side = await determineOrderSide(data.tokenIn, data.tokenOut, obDetails.pairId);
                    }

                    // Determine price used for this route (either global trade price or route price)
                    const orderPriceRaw = data.price !== undefined ? data.price : obDetails.price;
                    if (side === OrderSide.BUY && orderPriceRaw === undefined) {
                        logger.warn('[hybrid-trade] Validation: ORDERBOOK BUY route requires a price to validate required quote balance.');
                        return false;
                    }

                    const allocation = route.allocation || 100;
                    const routeAmountIn = (toBigInt(data.amountIn) * toBigInt(allocation)) / toBigInt(100);
                    if (routeAmountIn <= 0n) continue;

                    let requiredToken: string;
                    let requiredAmount: bigint = toBigInt(0);

                    if (side === OrderSide.BUY) {
                        // Follow same math as execution: compute orderQuantity then recompute quote required
                        const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
                        const priceBI = toBigInt(orderPriceRaw as any);
                        const scale = 10n ** BigInt(baseDecimals);
                        const orderQuantity = (routeAmountIn * scale) / priceBI; // integer division
                        const computedQuote = (orderQuantity * priceBI) / scale; // integer division mirrors execution
                        requiredToken = pair.quoteAssetSymbol;
                        requiredAmount = computedQuote;
                    } else {
                        // SELL: user spends base token equal to routeAmountIn
                        requiredToken = pair.baseAssetSymbol;
                        requiredAmount = routeAmountIn;
                    }

                    const senderBalForRequired = toBigInt((senderAccount!.balances && senderAccount!.balances[requiredToken]) || '0');
                    if (senderBalForRequired < requiredAmount) {
                        logger.warn(
                            `[hybrid-trade] Insufficient balance for ${requiredToken}. Required: ${requiredAmount}, Available: ${senderBalForRequired} (needed for ORDERBOOK route)`
                        );
                        return false;
                    }
                } catch (err) {
                    logger.error(`[hybrid-trade] Error during route-level validation: ${err}`);
                    return false;
                }
            }
        }

        if (data.routes && data.routes.length > 0) {
            const totalAllocation = data.routes.reduce((sum, route) => sum + route.allocation, 0);
            if (Math.abs(totalAllocation - 100) > 0.01) {
                logger.warn('[hybrid-trade] Route allocations must sum to 100%.');
                return false;
            }

            for (const route of data.routes) {
                if (route.allocation <= 0 || route.allocation > 100) {
                    logger.warn('[hybrid-trade] Route allocation must be between 0 and 100.');
                    return false;
                }
            }
        } else {
            if (!data.price) {
                const sources = await liquidityAggregator.getLiquiditySources(data.tokenIn, data.tokenOut);
                if (sources.length === 0) {
                    logger.warn(`[hybrid-trade] No liquidity sources found for ${data.tokenIn}/${data.tokenOut}. Cannot auto-route trade.`);
                    return false;
                }

                const hasLiquidity = sources.some(source => {
                    if (source.type === 'AMM') {
                        return source.hasLiquidity;
                    } else if (source.type === 'ORDERBOOK') {
                        return toBigInt(source.bidDepth || '0') > 0n || toBigInt(source.askDepth || '0') > 0n;
                    }
                    return false;
                });

                if (!hasLiquidity) {
                    logger.warn(
                        `[hybrid-trade] No liquidity available for ${data.tokenIn}/${data.tokenOut}. Pools exist but have no liquidity, and orderbook has no orders.`
                    );
                    return false;
                }

                const ammSources = sources.filter(source => source.type === 'AMM');
                for (const ammSource of ammSources) {
                    if (ammSource.hasLiquidity) {
                        const expectedOutput = calculateExpectedAMMOutput(toBigInt(data.amountIn), data.tokenIn, data.tokenOut, ammSource);

                        if (expectedOutput === toBigInt(0)) {
                            logger.warn(
                                `[hybrid-trade] AMM route would produce zero output for ${data.amountIn} ${data.tokenIn} -> ${data.tokenOut}. Trade would fail.`
                            );
                            return false;
                        }
                    }
                }

                // If user provided minAmountOut, we must also ensure that automatic fallback to orderbook
                // (which happens in processTx when AMM output < minAmountOut) would be affordable by the sender.
                if (hasMinAmountOut) {
                    try {
                        const bestQuote = await liquidityAggregator.getBestQuote(data);
                        if (bestQuote) {
                            const ammOutput = toBigInt(bestQuote.amountOut);
                            const minOut = toBigInt(data.minAmountOut!);
                            if (ammOutput < minOut) {
                                // ProcessTx will create an ORDERBOOK route using calculatedPrice. Mirror that calculation
                                const pairId = await findTradingPairId(data.tokenIn, data.tokenOut);
                                if (!pairId) {
                                    logger.error(`[hybrid-trade] No trading pair found for ${data.tokenIn} and ${data.tokenOut} when validating orderbook fallback`);
                                    return false;
                                }
                                const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
                                if (!pair) {
                                    logger.error(`[hybrid-trade] Trading pair ${pairId} not found when validating orderbook fallback`);
                                    return false;
                                }

                                const orderSide = await determineOrderSide(data.tokenIn, data.tokenOut, pairId);
                                const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);

                                let calculatedPrice: bigint;
                                if (orderSide === OrderSide.BUY) {
                                    // User wants to buy base token with quote token
                                    calculatedPrice = (toBigInt(data.amountIn) * 10n ** BigInt(baseDecimals)) / toBigInt(data.minAmountOut);
                                } else {
                                    calculatedPrice = (toBigInt(data.minAmountOut!) * 10n ** BigInt(baseDecimals)) / toBigInt(data.amountIn);
                                }

                                // Now compute required deduction similarly to execution
                                let requiredToken: string;
                                let requiredAmount: bigint = 0n;
                                if (orderSide === OrderSide.BUY) {
                                    // Orderbook BUY will deduct quote token equal to roughly amountIn (see execution math)
                                    // Compute orderQuantity and then quote required
                                    const scale = 10n ** BigInt(baseDecimals);
                                    const orderQuantity = (toBigInt(data.amountIn) * scale) / calculatedPrice;
                                    requiredToken = pair.quoteAssetSymbol;
                                    requiredAmount = (orderQuantity * calculatedPrice) / scale;
                                } else {
                                    requiredToken = pair.baseAssetSymbol;
                                    requiredAmount = toBigInt(data.amountIn);
                                }

                                const senderBalForRequired = toBigInt((senderAccount!.balances && senderAccount!.balances[requiredToken]) || '0');
                                if (senderBalForRequired < requiredAmount) {
                                    logger.warn(
                                        `[hybrid-trade] Insufficient balance for ${requiredToken} to cover potential ORDERBOOK fallback. Required: ${requiredAmount}, Available: ${senderBalForRequired}`
                                    );
                                    return false;
                                }
                            }
                        }
                    } catch (err) {
                        logger.error(`[hybrid-trade] Error checking ORDERBOOK fallback affordability: ${err}`);
                        return false;
                    }
                }
            }
        }

        return true;
    } catch (error) {
        logger.error(`[hybrid-trade] Error validating trade data by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: HybridTradeData, sender: string, transactionId: string): Promise<boolean> {
    try {
        logger.debug(`[hybrid-trade] Processing hybrid trade from ${sender}: ${data.amountIn} ${data.tokenIn} -> ${data.tokenOut}`);

        // Get optimal route if not provided
        let routes = data.routes;
        if (!routes || routes.length === 0) {
            // Market order - try AMM first, fallback to orderbook if needed
            if (!data.price) {
                const quote = await liquidityAggregator.getBestQuote(data);
                if (!quote) {
                    logger.warn('[hybrid-trade] No liquidity available for this trade. This should have been caught during validation.');
                    return false;
                }

                // Check if AMM output meets minAmountOut requirement
                if (data.minAmountOut) {
                    const ammOutput = toBigInt(quote.amountOut);
                    const minOut = toBigInt(data.minAmountOut);
                    logger.info(`[hybrid-trade] Comparing AMM output ${ammOutput} (${quote.amountOut}) with minAmountOut ${minOut} (${data.minAmountOut})`);
                    if (ammOutput < minOut) {
                        // AMM output too low - use orderbook as limit order with calculated price

                        // Find the correct trading pair ID regardless of token order
                        const pairId = await findTradingPairId(data.tokenIn, data.tokenOut);
                        if (!pairId) {
                            logger.error(`[hybrid-trade] No trading pair found for ${data.tokenIn} and ${data.tokenOut}`);
                            return false;
                        }

                        // Get the trading pair to determine correct base/quote assignment
                        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
                        if (!pair) {
                            logger.error(`[hybrid-trade] Trading pair ${pairId} not found`);
                            return false;
                        }

                        // Determine the correct order side
                        const orderSide = await determineOrderSide(data.tokenIn, data.tokenOut, pairId);

                        // Calculate price based on the user's desired exchange rate
                        // Price should be: how much quote token per unit of base token
                        const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
                        const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);

                        let calculatedPrice: bigint;

                        if (orderSide === OrderSide.BUY) {
                            // User wants to buy base token with quote token
                            // From orderbook formula: quantity = (amountIn * 10^baseDecimals) / orderPrice
                            // Rearranging: orderPrice = (amountIn * 10^baseDecimals) / quantity
                            // where quantity is the desired amount of base token (minAmountOut)
                            calculatedPrice = (toBigInt(data.amountIn) * 10n ** BigInt(baseDecimals)) / toBigInt(data.minAmountOut);
                        } else {
                            // User wants to sell base token for quote token
                            // For sell orders, amountIn is base token, minAmountOut is quote token
                            // We need price in quote per base, so: price = minAmountOut / amountIn
                            // But we need to scale to the correct decimal precision for the orderbook
                            // const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);
                            // Calculate the price in the smallest units of both tokens
                            // price = (minAmountOut in quote units) / (amountIn in base units)
                            // Then scale to the orderbook's expected precision
                            calculatedPrice = (toBigInt(data.minAmountOut) * 10n ** BigInt(baseDecimals)) / toBigInt(data.amountIn);
                        }

                        logger.info(
                            `[hybrid-trade] AMM output ${quote.amountOut} below minAmountOut ${data.minAmountOut}. Routing to orderbook as ${orderSide} order at calculated price ${calculatedPrice} (base: ${pair.baseAssetSymbol}=${baseDecimals} decimals, quote: ${pair.quoteAssetSymbol}=${quoteDecimals} decimals)`
                        );

                        routes = [
                            {
                                type: 'ORDERBOOK',
                                allocation: 100,
                                details: {
                                    pairId: pairId,
                                    side: orderSide,
                                    orderType: OrderType.LIMIT,
                                    price: calculatedPrice.toString(),
                                },
                            },
                        ];
                    } else {
                        logger.info(`[hybrid-trade] AMM output ${ammOutput} meets minAmountOut ${minOut} requirement. Using AMM route.`);
                    }
                }

                if (!routes) {
                    // AMM output meets requirements - use AMM route
                    routes = quote.routes.map(r => ({
                        type: r.type,
                        allocation: r.allocation,
                        details: r.details,
                    }));
                }
            } else {
                // For limit orders with specific price, default to orderbook only
                logger.debug('[hybrid-trade] Using orderbook route for limit order with specific price');

                // Find the correct trading pair ID regardless of token order
                const pairId = await findTradingPairId(data.tokenIn, data.tokenOut);
                if (!pairId) {
                    logger.error(`[hybrid-trade] No trading pair found for ${data.tokenIn} and ${data.tokenOut}`);
                    return false;
                }

                // Determine the correct order side
                const orderSide = await determineOrderSide(data.tokenIn, data.tokenOut, pairId);

                routes = [
                    {
                        type: 'ORDERBOOK',
                        allocation: 100,
                        details: {
                            pairId: pairId,
                            side: orderSide,
                            orderType: OrderType.LIMIT,
                            price: data.price,
                        },
                    },
                ];
            }
        }

        // Execute trades across all routes
        if (!routes || routes.length === 0) {
            logger.error('[hybrid-trade] No routes available for execution.');
            return false;
        }

        // Pre-execution affordability check: ensure sender has sufficient balances for deductions
        try {
            const senderAccountForCheck = await getAccount(sender);
            if (!senderAccountForCheck) {
                logger.warn(`[hybrid-trade] Sender account ${sender} not found before execution.`);
                return false;
            }

            for (const route of routes) {
                const allocation = route.allocation || 100;
                const routeAmountIn = (toBigInt(data.amountIn) * toBigInt(allocation)) / toBigInt(100);
                if (routeAmountIn <= 0n) continue;

                if (route.type === 'ORDERBOOK') {
                    const obDetails = route.details as any;
                    const pair = await cache.findOnePromise('tradingPairs', { _id: obDetails.pairId });
                    if (!pair) {
                        logger.warn(`[hybrid-trade] Execution validation: Trading pair ${obDetails.pairId} not found for route.`);
                        return false;
                    }

                    // Determine order side and price
                    const side = obDetails.side || (await determineOrderSide(data.tokenIn, data.tokenOut, obDetails.pairId));
                    const orderPriceRaw = data.price !== undefined ? data.price : obDetails.price;
                    if (side === OrderSide.BUY && orderPriceRaw === undefined) {
                        logger.warn('[hybrid-trade] Execution validation: ORDERBOOK BUY route requires a price to validate required quote balance.');
                        return false;
                    }

                    let requiredToken: string;
                    let requiredAmount: bigint = 0n;

                    if (side === OrderSide.BUY) {
                        const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
                        const scale = 10n ** BigInt(baseDecimals);
                        const priceBI = toBigInt(orderPriceRaw as any);
                        const orderQuantity = (routeAmountIn * scale) / priceBI;
                        requiredToken = pair.quoteAssetSymbol;
                        requiredAmount = (orderQuantity * priceBI) / scale;
                    } else {
                        requiredToken = pair.baseAssetSymbol;
                        requiredAmount = routeAmountIn;
                    }

                    const senderBalForRequired = toBigInt((senderAccountForCheck.balances && senderAccountForCheck.balances[requiredToken]) || '0');
                    if (senderBalForRequired < requiredAmount) {
                        logger.warn(
                            `[hybrid-trade] Execution validation: Insufficient balance for ${requiredToken}. Required: ${requiredAmount}, Available: ${senderBalForRequired}`
                        );
                        return false;
                    }
                } else if (route.type === 'AMM') {
                    // For AMM routes, ensure user has the input token (data.tokenIn) for the allocation
                    const senderBal = toBigInt((senderAccountForCheck.balances && senderAccountForCheck.balances[data.tokenIn]) || '0');
                    if (senderBal < routeAmountIn) {
                        logger.warn(`[hybrid-trade] Execution validation: Insufficient balance for ${data.tokenIn}. Required: ${routeAmountIn}, Available: ${senderBal}`);
                        return false;
                    }
                }
            }
        } catch (err) {
            logger.error(`[hybrid-trade] Error during pre-execution affordability check: ${err}`);
            return false;
        }

        const results: HybridTradeResult['executedRoutes'] = [];
        let totalAmountOut = toBigInt(0);
        let totalAmountIn = toBigInt(0);

        for (const route of routes) {
            const routeAmountIn = (toBigInt(data.amountIn) * toBigInt(route.allocation)) / toBigInt(100);
            if (routeAmountIn <= toBigInt(0)) {
                continue;
            }

            // Enforce tick/lot size alignment for orderbook routes
            if (route.type === 'ORDERBOOK') {
                const obDetails = route.details as import('./market-interfaces.js').OrderbookRouteDetails;
                const pair = await cache.findOnePromise('tradingPairs', { _id: obDetails.pairId });
                if (!pair) {
                    logger.error(`[hybrid-trade] Trading pair ${obDetails.pairId} not found for tick/lot size check.`);
                    continue;
                }
                const tickSize = toBigInt(pair.tickSize);
                const lotSize = toBigInt(pair.lotSize);
                const price = obDetails.price !== undefined ? toBigInt(obDetails.price) : undefined;
                const quantity = routeAmountIn;
                if (price !== undefined && !isAlignedToTickSize(price, tickSize)) {
                    logger.warn(`[hybrid-trade] Order price ${price} is not aligned to tick size ${tickSize}. Rejecting order.`);
                    continue;
                }
                if (!isAlignedToLotSize(quantity, lotSize)) {
                    logger.warn(`[hybrid-trade] Order quantity ${quantity} is not aligned to lot size ${lotSize}. Rejecting order.`);
                    continue;
                }
            }

            let routeResult: { success: boolean; amountOut: bigint; error?: string };
            if (route.type === 'AMM') {
                routeResult = await executeAMMRoute(route, data, routeAmountIn, sender, transactionId);
            } else {
                routeResult = await executeOrderbookRoute(route, data, routeAmountIn, sender, transactionId);
            }

            if (routeResult.success) {
                results.push({
                    type: route.type,
                    amountIn: routeAmountIn.toString(),
                    amountOut: routeResult.amountOut.toString(),
                    transactionId,
                });
                totalAmountOut += routeResult.amountOut;
                totalAmountIn += routeAmountIn;
            } else {
                logger.error(`[hybrid-trade] Failed to execute ${route.type} route: ${routeResult.error}`);
                // Continue with other routes - partial execution is allowed
                // Individual route failures don't fail the entire trade unless all routes fail
            }
        }

        if (results.length === 0) {
            logger.error('[hybrid-trade] All routes failed to execute.');
            return false;
        }

        // Check slippage protection (this should rarely happen now with smart routing)
        if (data.minAmountOut) {
            const minOut = toBigInt(data.minAmountOut);
            // Determine if the final route is a limit order (not just if the original request had price)
            let finalRouteIsLimitOrder = false;
            if (routes.length === 1 && routes[0].type === 'ORDERBOOK') {
                const details = routes[0].details as any;
                finalRouteIsLimitOrder = details.orderType === OrderType.LIMIT;
            }
            const hadImmediateFill = totalAmountOut > toBigInt(0);

            // If the final route is a limit order and there were no immediate fills,
            // don't treat the lack of immediate output as a slippage failure — the order was posted
            // to the book and may fill later. Only enforce minAmountOut when either the route is
            // not a limit order (e.g., market order routed through AMM/orderbook) or when
            // there were immediate fills to compare against.
            if (!finalRouteIsLimitOrder || hadImmediateFill) {
                if (totalAmountOut < minOut) {
                    logger.warn(
                        `[hybrid-trade] Slippage protection triggered: Output amount ${totalAmountOut} is less than minimum required ${data.minAmountOut}. This suggests the orderbook route also couldn't meet your price requirements. Consider adjusting your minAmountOut or using maxSlippagePercent.`
                    );
                    // In a production system, you'd want to rollback here
                    return false;
                }
            } else {
                logger.info('[hybrid-trade] Limit order placed with no immediate fills; minAmountOut check deferred until fills occur.');
                // For limit orders with no immediate fills, we consider the trade successful
                // The order is placed and will be filled when matching orders are available
                return true;
            }
        }

        // Calculate actual price impact
        // const actualPriceImpact = results.length > 0 ? Number(totalAmountIn - totalAmountOut) / Number(totalAmountIn) : 0;

        logger.debug(`[hybrid-trade] Hybrid trade completed: ${totalAmountIn} ${data.tokenIn} -> ${totalAmountOut} ${data.tokenOut}`);
        return true;
    } catch (error) {
        logger.error(`[hybrid-trade] Error processing hybrid trade by ${sender}: ${error}`);
        return false;
    }
}

const TEST_HOOKS: any = {};
export function __setTestHooks(hooks: any) {
    Object.assign(TEST_HOOKS, hooks);
}

export async function executeAMMRoute(
    route: HybridRoute,
    tradeData: HybridTradeData,
    amountIn: bigint,
    sender: string,
    transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
    try {
        const ammDetails = route.details as any; // AMMRouteDetails
        const slippagePercent = tradeData.maxSlippagePercent || 1.0;
        if (ammDetails.expectedOutput && toBigInt(ammDetails.expectedOutput) === toBigInt(0)) {
            return { success: false, amountOut: toBigInt(0), error: 'Expected output is zero for this AMM route' };
        }
        const swapData = {
            tokenIn_symbol: tradeData.tokenIn,
            tokenOut_symbol: tradeData.tokenOut,
            amountIn: amountIn.toString(),
            minAmountOut: '1', // Minimum 1 unit (route-level, overall slippage checked later)
            slippagePercent: slippagePercent, // Use user's slippage preference
            poolId: ammDetails.poolId,
            hops: ammDetails.hops,
        };

        const isValid = await poolSwap.validateTx(swapData, sender);
        if (!isValid) {
            return { success: false, amountOut: toBigInt(0), error: 'AMM swap validation failed' };
        }
        const processWithResultFn = TEST_HOOKS.processWithResult || processWithResult;
        const swapResult: PoolSwapResult = await processWithResultFn(swapData, sender, transactionId);
        if (!swapResult.success) {
            return { success: false, amountOut: toBigInt(0), error: swapResult.error || 'AMM swap execution failed' };
        }
        const recordAMMTradeFn = TEST_HOOKS.recordAMMTrade || recordAMMTrade;
        await recordAMMTradeFn({
            poolId: ammDetails.poolId,
            tokenIn: tradeData.tokenIn,
            tokenOut: tradeData.tokenOut,
            amountIn: amountIn,
            amountOut: swapResult.amountOut,
            sender: sender,
            transactionId: transactionId,
        });
        return { success: true, amountOut: swapResult.amountOut };
    } catch (error) {
        return { success: false, amountOut: toBigInt(0), error: `AMM route error: ${error}` };
    }
}

/**
 * Execute trade through orderbook route
 */
export async function executeOrderbookRoute(
    route: HybridRoute,
    tradeData: HybridTradeData,
    amountIn: bigint,
    sender: string,
    transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
    try {
        const orderbookDetails = route.details as any; // OrderbookRouteDetails
        logger.debug(`[executeOrderbookRoute] Route details:`, orderbookDetails);

        // Determine order type based on whether price is specified in tradeData OR route details
        const orderType = tradeData.price || orderbookDetails.price ? OrderType.LIMIT : OrderType.MARKET;
        // Get the trading pair to determine correct base/quote assignment
        const pair = await cache.findOnePromise('tradingPairs', { _id: orderbookDetails.pairId });
        if (!pair) {
            return {
                success: false,
                amountOut: toBigInt(0),
                error: `Trading pair ${orderbookDetails.pairId} not found`,
            };
        }

        // Get the price for this order
        const orderPrice = tradeData.price || orderbookDetails.price;
        logger.info(
            `[executeOrderbookRoute] Order price: ${orderPrice}, tradeData.price: ${tradeData.price}, orderbookDetails.price: ${orderbookDetails.price}`
        );

        // Debug price formatting
        if (orderPrice) {
            const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);
            const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
            // Avoid Number/Math.pow conversions which lose precision for BigInt values.
            logger.info(`[executeOrderbookRoute] Price formatting debug: raw=${orderPrice}, quoteDecimals=${quoteDecimals}, baseDecimals=${baseDecimals}`);
            // Show raw integer price and note the decimals instead of attempting floating formatting
            logger.info(`[executeOrderbookRoute] Price (raw integer) = ${orderPrice}`);
            logger.info(`[executeOrderbookRoute] Price decimals: quote=${quoteDecimals}, base=${baseDecimals}`);
        }

        // Calculate the correct quantity based on order side
        let orderQuantity: bigint;
        if (orderbookDetails.side === OrderSide.BUY) {
            // For buy orders, quantity should be the amount of base currency to buy
            // Universal formula for any decimals:
            // quantity = (amountIn * 10^(baseDecimals)) / price
            // where amountIn is in quote token's smallest units, price is in quote token's smallest units per base token
            if (!orderPrice) {
                return { success: false, amountOut: toBigInt(0), error: 'Price required for buy orders' };
            }

            const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
            // Use BigInt exponentiation to avoid floating point errors
            const scale = 10n ** BigInt(baseDecimals);
            orderQuantity = (amountIn * scale) / toBigInt(orderPrice);
        } else {
            // For sell orders, quantity is the amount of base currency to sell
            // amountIn is the amount of base token (MRY) the user wants to sell
            orderQuantity = amountIn;
        }

        logger.info(`[executeOrderbookRoute] Order quantity: ${orderQuantity}, amountIn: ${amountIn}, orderPrice: ${orderPrice}`);

        // Create order (limit or market) with deterministic ID generation
        const orderData: any = {
            userId: sender,
            pairId: orderbookDetails.pairId,
            type: orderType,
            side: orderbookDetails.side,
            quantity: orderQuantity,
            baseAssetSymbol: pair.baseAssetSymbol,
            quoteAssetSymbol: pair.quoteAssetSymbol,
            transactionId: transactionId, // Use transaction ID for deterministic ID generation
        };

        // Add price for limit orders (from tradeData or route details)
        if (orderType === OrderType.LIMIT) {
            orderData.price = orderPrice;
            logger.info(`[executeOrderbookRoute] Setting order price to: ${orderData.price}`);
        }

        const createdOrder = createOrder(orderData);

        let deductToken: string;
        let deductAmount: bigint;
        if (orderbookDetails.side === OrderSide.BUY) {
            // For buy orders the user spends quote token. Compute required quote amount from
            // order quantity and price using token decimals to avoid unit mismatches.
            deductToken = pair.quoteAssetSymbol;
            const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
            // orderData.quantity is in base token smallest units (BigInt), orderPrice is raw integer quote-per-base
            // quoteAmount = (quantity * price) / 10^baseDecimals
            deductAmount = (orderQuantity * toBigInt(orderData.price || orderPrice || '0')) / (10n ** BigInt(baseDecimals));
        } else {
            // For sell orders the user spends base token; amountIn is already in base units
            deductToken = pair.baseAssetSymbol;
            deductAmount = amountIn;
        }
        logger.info(`[executeOrderbookRoute] Deducting ${deductAmount} ${deductToken} from user ${sender}`);
        const adjustUserBalanceFn = TEST_HOOKS.adjustUserBalance || adjustUserBalance;
        const deductionSuccess = await adjustUserBalanceFn(sender, deductToken, -deductAmount);
        if (!deductionSuccess) {
            logger.warn(`[executeOrderbookRoute] Failed to deduct ${deductAmount} ${deductToken} from user ${sender}`);
            return { success: false, amountOut: toBigInt(0), error: `Insufficient balance for ${deductToken}` };
        }

        // Submit to matching engine (use test-injected matching engine if provided)
        const matchingEngineInstance = TEST_HOOKS.matchingEngine || matchingEngine;
        const result = await matchingEngineInstance.addOrder(createdOrder);

        if (!result.accepted) {
            return { success: false, amountOut: toBigInt(0), error: result.rejectReason };
        }

        // For limit orders, the order might not be filled immediately
        if (orderType === OrderType.LIMIT && result.trades.length === 0) {
            logger.info(`[hybrid-trade] Limit order placed at price ${orderPrice}, waiting for matching`);
            return { success: true, amountOut: toBigInt(0) }; // Order placed but not filled yet
        }

        // Calculate output from trades (for market orders or partially filled limit orders)
        const totalOutput = result.trades.reduce((sum: bigint, trade: any) => sum + toBigInt(trade.quantity), toBigInt(0));

        return { success: true, amountOut: totalOutput };
    } catch (error) {
        return { success: false, amountOut: toBigInt(0), error: `Orderbook route error: ${error}` };
    }
}
