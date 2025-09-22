import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { HybridTradeData, HybridTradeResult, HybridRoute } from './market-interfaces.js';
import { liquidityAggregator } from './market-aggregator.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt, getTokenDecimals, calculateDecimalAwarePrice, toDbString } from '../../utils/bigint.js';

// Import transaction processors for different route types
import * as poolSwap from '../pool/pool-swap.js';
import { PoolSwapResult } from '../pool/pool-interfaces.js';
import { calculateExpectedAMMOutput } from '../../utils/pool.js';
import { matchingEngine } from '../market/matching-engine.js';
import { OrderType, OrderSide, createOrder, isAlignedToTickSize, isAlignedToLotSize } from '../market/market-interfaces.js';
import { determineOrderSide, findTradingPairId, recordAMMTrade } from '../../utils/trade.js';

export async function validateTx(data: HybridTradeData, sender: string): Promise<boolean> {
  try {
    if (!data.tokenIn || !data.tokenOut || data.amountIn === undefined) {
      logger.warn('[hybrid-trade] Invalid data: Missing required fields (tokenIn, tokenOut, amountIn).');
      return false;
    }

    if (!validate.string(data.tokenIn, 64, 1)) {
      logger.warn('[hybrid-trade] Invalid tokenIn format.');
      return false;
    }

    if (!validate.string(data.tokenOut, 64, 1)) {
      logger.warn('[hybrid-trade] Invalid tokenOut format.');
      return false;
    }

    // Validate tokens by symbol only (issuer optional/ignored)
    const tokenInSymbol = data.tokenIn;
    const tokenOutSymbol = data.tokenOut;

    // Check if tokenIn exists by symbol
    const tokenInExists = await cache.findOnePromise('tokens', {
      symbol: tokenInSymbol
    });
    if (!tokenInExists) {
      logger.warn(`[hybrid-trade] Token ${data.tokenIn} does not exist. Symbol "${tokenInSymbol}" not found in the system.`);
      return false;
    }

    // Check if tokenOut exists by symbol
    const tokenOutExists = await cache.findOnePromise('tokens', {
      symbol: tokenOutSymbol
    });
    if (!tokenOutExists) {
      logger.warn(`[hybrid-trade] Token ${data.tokenOut} does not exist. Symbol "${tokenOutSymbol}" not found in the system.`);
      return false;
    }

    if (data.tokenIn === data.tokenOut) {
      logger.warn('[hybrid-trade] Cannot trade the same token.');
      return false;
    }

    if (toBigInt(data.amountIn) <= BigInt(0)) {
      logger.warn('[hybrid-trade] amountIn must be positive.');
      return false;
    }

    // Validate slippage protection vs price specification
    const hasPrice = data.price !== undefined;
    const hasMinAmountOut = data.minAmountOut !== undefined;
    const hasMaxSlippage = data.maxSlippagePercent !== undefined;

    if (hasPrice && (hasMinAmountOut || hasMaxSlippage)) {
      logger.warn('[hybrid-trade] Cannot specify price together with slippage protection (minAmountOut or maxSlippagePercent). Choose either specific price or slippage protection.');
      return false;
    }

    if (!hasPrice && !hasMinAmountOut && !hasMaxSlippage) {
      logger.warn('[hybrid-trade] Must specify either price, minAmountOut, or maxSlippagePercent. For market orders, maxSlippagePercent is recommended for better user experience.');
      return false;
    }

    if (hasMinAmountOut && hasMaxSlippage) {
      logger.warn('[hybrid-trade] Cannot specify both minAmountOut and maxSlippagePercent. Choose one slippage protection method.');
      return false;
    }

    // For market orders (no specific price), prefer maxSlippagePercent over minAmountOut
    if (!hasPrice && hasMinAmountOut && !hasMaxSlippage) {
      logger.info('[hybrid-trade] Using minAmountOut for market order. If AMM output is below this threshold, the trade will be routed to orderbook as a limit order for better price protection.');
    }

    if (hasPrice && toBigInt(data.price!) <= BigInt(0)) {
      logger.warn('[hybrid-trade] price must be positive.');
      return false;
    }

    if (hasMinAmountOut && toBigInt(data.minAmountOut!) < BigInt(0)) {
      logger.warn('[hybrid-trade] minAmountOut cannot be negative.');
      return false;
    }

    // Log info for very unusual minAmountOut ratios but allow all transactions
    // Token decimals can vary from 0 to 18, creating legitimate ratios up to 10^18
    if (hasMinAmountOut) {
      const amountIn = toBigInt(data.amountIn);
      const minAmountOut = toBigInt(data.minAmountOut!);

      // Only warn for extremely unusual ratios (more than 10^20 to catch obvious errors)
      // But still allow the transaction - different token decimals can create huge legitimate ratios
      if (minAmountOut > amountIn * BigInt(10) ** BigInt(20)) {
        logger.warn(`[hybrid-trade] minAmountOut ${minAmountOut} is unusually high compared to input amount ${amountIn}. Please verify this is correct.`);
      }
    }

    if (hasMaxSlippage && (data.maxSlippagePercent! < 0 || data.maxSlippagePercent! > 100)) {
      logger.warn('[hybrid-trade] maxSlippagePercent must be between 0 and 100.');
      return false;
    }

    // Check sender's balance
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

    // Validate routes if provided
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
      // No routes provided - check if liquidity exists for auto-routing
      // Only check for market orders (no specific price) since limit orders default to orderbook
      if (!data.price) {
        const sources = await liquidityAggregator.getLiquiditySources(data.tokenIn, data.tokenOut);
        if (sources.length === 0) {
          logger.warn(`[hybrid-trade] No liquidity sources found for ${data.tokenIn}/${data.tokenOut}. Cannot auto-route trade.`);
          return false;
        }

        // Check if any source has actual liquidity
        const hasLiquidity = sources.some(source => {
          if (source.type === 'AMM') {
            return source.hasLiquidity;
          } else if (source.type === 'ORDERBOOK') {
            return (toBigInt(source.bidDepth || '0') > 0n) || (toBigInt(source.askDepth || '0') > 0n);
          }
          return false;
        });

        if (!hasLiquidity) {
          logger.warn(`[hybrid-trade] No liquidity available for ${data.tokenIn}/${data.tokenOut}. Pools exist but have no liquidity, and orderbook has no orders.`);
          return false;
        }

        // For AMM sources, validate that the expected output would be greater than 0
        const ammSources = sources.filter(source => source.type === 'AMM');
        for (const ammSource of ammSources) {
          if (ammSource.hasLiquidity) {
            const expectedOutput = calculateExpectedAMMOutput(
              toBigInt(data.amountIn),
              data.tokenIn,
              data.tokenOut,
              ammSource
            );

            if (expectedOutput === BigInt(0)) {
              logger.warn(`[hybrid-trade] AMM route would produce zero output for ${data.amountIn} ${data.tokenIn} -> ${data.tokenOut}. Trade would fail.`);
              return false;
            }
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

export async function process(data: HybridTradeData, sender: string, transactionId: string): Promise<boolean> {
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
        if (data.minAmountOut && toBigInt(quote.amountOut) < toBigInt(data.minAmountOut)) {
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
            calculatedPrice = (toBigInt(data.amountIn) * BigInt(10 ** baseDecimals)) / toBigInt(data.minAmountOut);
          } else {
            // User wants to sell base token for quote token  
            // For sell orders, amountIn is base token, minAmountOut is quote token
            // We need price in quote per base, so: price = minAmountOut per amountIn
            calculatedPrice = (toBigInt(data.minAmountOut) * BigInt(10 ** baseDecimals)) / toBigInt(data.amountIn);
          }

          logger.info(`[hybrid-trade] AMM output ${quote.amountOut} below minAmountOut ${data.minAmountOut}. Routing to orderbook as ${orderSide} order at calculated price ${calculatedPrice} (base: ${pair.baseAssetSymbol}=${baseDecimals} decimals, quote: ${pair.quoteAssetSymbol}=${quoteDecimals} decimals)`);

          routes = [{
            type: 'ORDERBOOK',
            allocation: 100,
            details: {
              pairId: pairId,
              side: orderSide,
              orderType: OrderType.LIMIT,
              price: calculatedPrice.toString()
            }
          }];
        } else {
          // AMM output meets requirements - use AMM route
          routes = quote.routes.map(r => ({
            type: r.type,
            allocation: r.allocation,
            details: r.details
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

        routes = [{
          type: 'ORDERBOOK',
          allocation: 100,
          details: {
            pairId: pairId,
            side: orderSide,
            orderType: OrderType.LIMIT,
            price: data.price
          }
        }];
      }
    }

    // Execute trades across all routes
    if (!routes || routes.length === 0) {
      logger.error('[hybrid-trade] No routes available for execution.');
      return false;
    }

    const results: HybridTradeResult['executedRoutes'] = [];
    let totalAmountOut = BigInt(0);
    let totalAmountIn = BigInt(0);

    for (const route of routes) {
      const routeAmountIn = (toBigInt(data.amountIn) * BigInt(route.allocation)) / BigInt(100);
      if (routeAmountIn <= BigInt(0)) {
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
        let price = obDetails.price !== undefined ? toBigInt(obDetails.price) : undefined;
        let quantity = routeAmountIn;
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
          transactionId
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
      const hadImmediateFill = totalAmountOut > BigInt(0);

      // If the final route is a limit order and there were no immediate fills,
      // don't treat the lack of immediate output as a slippage failure — the order was posted
      // to the book and may fill later. Only enforce minAmountOut when either the route is
      // not a limit order (e.g., market order routed through AMM/orderbook) or when
      // there were immediate fills to compare against.
      if (!finalRouteIsLimitOrder || hadImmediateFill) {
        if (totalAmountOut < minOut) {
          logger.warn(`[hybrid-trade] Slippage protection triggered: Output amount ${totalAmountOut} is less than minimum required ${data.minAmountOut}. This suggests the orderbook route also couldn't meet your price requirements. Consider adjusting your minAmountOut or using maxSlippagePercent.`);
          // In a production system, you'd want to rollback here
          return false;
        }
      } else {
        logger.info('[hybrid-trade] Limit order placed with no immediate fills; minAmountOut check deferred until fills occur.');
      }
    }

    // Calculate actual price impact
    const actualPriceImpact = results.length > 0 ?
      Number(totalAmountIn - totalAmountOut) / Number(totalAmountIn) : 0;


    logger.debug(`[hybrid-trade] Hybrid trade completed: ${totalAmountIn} ${data.tokenIn} -> ${totalAmountOut} ${data.tokenOut}`);
    return true;

  } catch (error) {
    logger.error(`[hybrid-trade] Error processing hybrid trade by ${sender}: ${error}`);
    return false;
  }
}

/**
 * Execute trade through AMM route
 */
async function executeAMMRoute(
  route: HybridRoute,
  tradeData: HybridTradeData,
  amountIn: bigint,
  sender: string,
  transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
  try {
    const ammDetails = route.details as any; // AMMRouteDetails

    // Use user's slippagePercent if provided, otherwise default to 1%
    const slippagePercent = tradeData.maxSlippagePercent || 1.0;

    // Pre-validate that this route would produce non-zero output
    // This is an additional safeguard beyond the main validation
    if (ammDetails.expectedOutput && toBigInt(ammDetails.expectedOutput) === BigInt(0)) {
      return { success: false, amountOut: BigInt(0), error: 'Expected output is zero for this AMM route' };
    }

    // Create pool swap data
    const swapData = {
      tokenIn_symbol: tradeData.tokenIn,
      tokenOut_symbol: tradeData.tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: '1', // Minimum 1 unit (route-level, overall slippage checked later)
      slippagePercent: slippagePercent, // Use user's slippage preference
      poolId: ammDetails.poolId,
      hops: ammDetails.hops
    };

    // Validate and execute the swap using the new function that returns output amount
    const isValid = await poolSwap.validateTx(swapData, sender);
    if (!isValid) {
      return { success: false, amountOut: BigInt(0), error: 'AMM swap validation failed' };
    }

    // Use the new processWithResult function to get the actual output amount
    const swapResult: PoolSwapResult = await poolSwap.processWithResult(swapData, sender, transactionId);

    if (!swapResult.success) {
      return { success: false, amountOut: BigInt(0), error: swapResult.error || 'AMM swap execution failed' };
    }

    // Record the AMM trade in the trades collection for market statistics
    await recordAMMTrade({
      poolId: ammDetails.poolId,
      tokenIn: tradeData.tokenIn,
      tokenOut: tradeData.tokenOut,
      amountIn: amountIn,
      amountOut: swapResult.amountOut,
      sender: sender,
      transactionId: transactionId
    });

    // Return the actual output amount from the swap
    return { success: true, amountOut: swapResult.amountOut };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `AMM route error: ${error}` };
  }
}

/**
 * Execute trade through orderbook route
 */
async function executeOrderbookRoute(
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
    const orderType = (tradeData.price || orderbookDetails.price) ? OrderType.LIMIT : OrderType.MARKET;
    logger.debug(`[executeOrderbookRoute] Order type: ${orderType}, tradeData.price: ${tradeData.price}, orderbookDetails.price: ${orderbookDetails.price}`);

    // Get the trading pair to determine correct base/quote assignment
    const pair = await cache.findOnePromise('tradingPairs', { _id: orderbookDetails.pairId });
    if (!pair) {
      return { success: false, amountOut: BigInt(0), error: `Trading pair ${orderbookDetails.pairId} not found` };
    }

    // Get the price for this order
    const orderPrice = tradeData.price || orderbookDetails.price;
    logger.info(`[executeOrderbookRoute] Order price: ${orderPrice}, tradeData.price: ${tradeData.price}, orderbookDetails.price: ${orderbookDetails.price}`);

    // Calculate the correct quantity based on order side
    let orderQuantity: bigint;
    if (orderbookDetails.side === OrderSide.BUY) {
      // For buy orders, quantity should be the amount of base currency to buy
      // Universal formula for any decimals:
      // quantity = (amountIn * 10^(baseDecimals)) / price
      // where amountIn is in quote token's smallest units, price is in quote token's smallest units per base token
      if (!orderPrice) {
        return { success: false, amountOut: BigInt(0), error: 'Price required for buy orders' };
      }

      const baseDecimals = getTokenDecimals(pair.baseAssetSymbol);
      const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);
      // This formula works for any decimals:
      // With price in quoteDecimals, use:
      // quantity = (amountIn * 10^baseDecimals) / orderPrice
      orderQuantity = (amountIn * BigInt(10 ** baseDecimals)) / toBigInt(orderPrice);
    } else {
      // For sell orders, quantity is the amount of base currency to sell
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
      transactionId: transactionId // Use transaction ID for deterministic ID generation
    };

    // Add price for limit orders (from tradeData or route details)
    if (orderType === OrderType.LIMIT) {
      orderData.price = orderPrice;
      logger.info(`[executeOrderbookRoute] Setting order price to: ${orderData.price}`);
    }

    const createdOrder = createOrder(orderData);

    let deductToken: string;
    if (orderbookDetails.side === OrderSide.BUY) {
      deductToken = pair.quoteAssetSymbol;
    } else {
      deductToken = pair.baseAssetSymbol;
    }
    const deductionSuccess = await adjustBalance(sender, deductToken, -amountIn);
    if (!deductionSuccess) {
      logger.warn(`[executeOrderbookRoute] Failed to deduct ${amountIn} ${deductToken} from user ${sender}`);
      return { success: false, amountOut: BigInt(0), error: `Insufficient balance for ${deductToken}` };
    }

    // Submit to matching engine
    const result = await matchingEngine.addOrder(createdOrder);

    if (!result.accepted) {
      return { success: false, amountOut: BigInt(0), error: result.rejectReason };
    }

    // For limit orders, the order might not be filled immediately
    if (orderType === OrderType.LIMIT && result.trades.length === 0) {
      logger.info(`[hybrid-trade] Limit order placed at price ${orderPrice}, waiting for matching`);
      return { success: true, amountOut: BigInt(0) }; // Order placed but not filled yet
    }

    // Calculate output from trades (for market orders or partially filled limit orders)
    const totalOutput = result.trades.reduce((sum, trade) =>
      sum + toBigInt(trade.quantity), BigInt(0));

    return { success: true, amountOut: totalOutput };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `Orderbook route error: ${error}` };
  }
}

