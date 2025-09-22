import cache from '../cache.js';
import logger from '../logger.js';
import { toBigInt, getTokenDecimals, calculateDecimalAwarePrice, toDbString } from './bigint.js';
import { OrderType, OrderSide, createOrder } from '../transactions/market/market-interfaces.js';
import crypto from 'crypto';

/**
 * Determine the correct order side based on trading pair and token direction
 */
export async function determineOrderSide(tokenIn: string, tokenOut: string, pairId: string): Promise<OrderSide> {
    // Get the trading pair to know which is base and which is quote
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
        throw new Error(`Trading pair ${pairId} not found`);
    }

    const baseAsset = pair.baseAssetSymbol;
    const quoteAsset = pair.quoteAssetSymbol;

    // If we're buying the base asset (tokenOut = base), it's a BUY
    // If we're selling the base asset (tokenIn = base), it's a SELL
    if (tokenOut === baseAsset) {
        return OrderSide.BUY;  // Buying base with quote
    } else if (tokenIn === baseAsset) {
        return OrderSide.SELL; // Selling base for quote
    } else {
        throw new Error(`Invalid trade direction for pair ${pairId}: ${tokenIn} → ${tokenOut}`);
    }
}

/**
 * Find the correct trading pair ID regardless of token order
 */
export async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
    // Try both possible combinations
    const pairId1 = `${tokenA}-${tokenB}`;
    const pairId2 = `${tokenB}-${tokenA}`;

    // Check if either pair exists
    const pair1 = await cache.findOnePromise('tradingPairs', { _id: pairId1 });
    if (pair1) {
        return pairId1;
    }

    const pair2 = await cache.findOnePromise('tradingPairs', { _id: pairId2 });
    if (pair2) {
        return pairId2;
    }

    return null;
}

/**
 * Record AMM trade in the trades collection for market statistics
 */
export async function recordAMMTrade(params: {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
    sender: string;
    transactionId: string;
}): Promise<void> {
    try {
        // Find the correct trading pair ID regardless of token order
        const pairId = await findTradingPairId(params.tokenIn, params.tokenOut);
        if (!pairId) {
            logger.warn(`[recordAMMTrade] No trading pair found for ${params.tokenIn}-${params.tokenOut}, skipping trade record`);
            return;
        }

        // Get the trading pair to determine correct base/quote assignment
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            logger.warn(`[recordAMMTrade] Trading pair ${pairId} not found, using token symbols as-is`);
        }

        // Determine correct base/quote mapping and price calculation
        let baseSymbol, quoteSymbol, quantity, volume, priceValue;
        if (pair) {
            // Use actual pair configuration
            baseSymbol = pair.baseAssetSymbol;
            quoteSymbol = pair.quoteAssetSymbol;

            // Determine which direction the trade went
            if (params.tokenOut === baseSymbol) {
                // User bought base asset with quote asset
                quantity = params.amountOut; // Amount of base received
                volume = params.amountIn;    // Amount of quote spent
                priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            } else {
                // User sold base asset for quote asset
                quantity = params.amountIn;  // Amount of base sold
                volume = params.amountOut;   // Amount of quote received
                priceValue = calculateDecimalAwarePrice(params.amountOut, params.amountIn, quoteSymbol, baseSymbol);
            }
        } else {
            // Fallback: calculate price with token decimal consideration
            baseSymbol = params.tokenOut;
            quoteSymbol = params.tokenIn;
            quantity = params.amountOut;
            volume = params.amountIn;
            priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
        }

        // Ensure price is not zero - if it is, calculate a simple price
        if (priceValue === 0n && quantity > 0n && volume > 0n) {
            // Calculate price considering decimal differences
            const tokenInDecimals = getTokenDecimals(params.tokenIn);
            const tokenOutDecimals = getTokenDecimals(params.tokenOut);
            const decimalDifference = tokenOutDecimals - tokenInDecimals;

            // Adjust for decimal differences in the calculation
            let adjustedVolume = volume;
            let adjustedQuantity = quantity;

            if (decimalDifference > 0) {
                // TokenOut has more decimals, scale up volume
                adjustedVolume = volume * BigInt(10 ** decimalDifference);
            } else if (decimalDifference < 0) {
                // TokenIn has more decimals, scale up quantity
                adjustedQuantity = quantity * BigInt(10 ** (-decimalDifference));
            }

            // Calculate price: (adjustedVolume * 10^quoteDecimals) / adjustedQuantity
            const quoteDecimals = getTokenDecimals(quoteSymbol);
            priceValue = (adjustedVolume * BigInt(10 ** quoteDecimals)) / adjustedQuantity;

            // Ensure price is never negative
            if (priceValue < 0n) {
                logger.error(`[recordAMMTrade] CRITICAL: Negative price calculated in fallback! Using 0 instead.`);
                priceValue = 0n;
            }

            logger.warn(`[recordAMMTrade] Price was 0, using decimal-aware calculation: ${priceValue} for ${volume} ${quoteSymbol}/${quantity} ${baseSymbol} (decimals: ${tokenInDecimals}/${tokenOutDecimals})`);
        }

        // Debug logging
        logger.info(`[recordAMMTrade] Trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut}`);
        logger.info(`[recordAMMTrade] Mapped: ${quantity} ${baseSymbol} (quantity), ${volume} ${quoteSymbol} (volume), price: ${priceValue}`);
        logger.info(`[recordAMMTrade] Pair: ${pairId}, Base: ${baseSymbol}, Quote: ${quoteSymbol}`);

        // Additional validation
        if (priceValue === 0n) {
            logger.error(`[recordAMMTrade] CRITICAL: Price is still 0 after all calculations!`);
            logger.error(`[recordAMMTrade] Input: ${params.amountIn} ${params.tokenIn}, Output: ${params.amountOut} ${params.tokenOut}`);
            logger.error(`[recordAMMTrade] Quantity: ${quantity}, Volume: ${volume}`);
        }

        // Final safety check - ensure price is never negative
        if (priceValue < 0n) {
            logger.error(`[recordAMMTrade] CRITICAL: Final price is negative! Setting to 0. Price: ${priceValue}`);
            priceValue = 0n;
        }

        // Determine the correct trade side based on token direction
        let tradeSide: 'buy' | 'sell';
        let buyerUserId: string;
        let sellerUserId: string;

        if (params.tokenOut === baseSymbol) {
            // User is buying the base asset (tokenOut = base), it's a BUY
            tradeSide = 'buy';
            buyerUserId = params.sender;
            sellerUserId = 'AMM';
        } else if (params.tokenIn === baseSymbol) {
            // User is selling the base asset (tokenIn = base), it's a SELL
            tradeSide = 'sell';
            buyerUserId = 'AMM';
            sellerUserId = params.sender;
        } else {
            // Fallback to buy if we can't determine the direction
            logger.warn(`[recordAMMTrade] Could not determine trade side for ${params.tokenIn} -> ${params.tokenOut}, defaulting to buy`);
            tradeSide = 'buy';
            buyerUserId = params.sender;
            sellerUserId = 'AMM';
        }

        // Create trade record matching the orderbook trade format with deterministic ID
        const tradeId = crypto.createHash('sha256')
            .update(`${pairId}-${params.tokenIn}-${params.tokenOut}-${params.sender}-${params.transactionId}-${params.amountOut}`)
            .digest('hex')
            .substring(0, 16);
        const tradeRecord = {
            _id: tradeId,
            pairId: pairId,
            baseAssetSymbol: baseSymbol,
            quoteAssetSymbol: quoteSymbol,
            makerOrderId: null, // AMM trades don't have maker orders
            takerOrderId: null, // AMM trades don't have taker orders
            buyerUserId: buyerUserId,
            sellerUserId: sellerUserId,
            price: toDbString(priceValue), // Use toDbString for proper BigInt conversion
            quantity: toDbString(quantity),
            volume: toDbString(volume),
            timestamp: Date.now(),
            side: tradeSide,
            type: 'market', // AMM trades are market orders
            source: 'pool', // Mark as pool source (changed from 'amm' to match your data)
            isMakerBuyer: false,
            feeAmount: '0', // Fees are handled in the pool swap
            feeCurrency: quoteSymbol,
            makerFee: '0',
            takerFee: '0',
            total: toDbString(volume)
        };

        // Save to trades collection
        await new Promise<void>((resolve, reject) => {
            cache.insertOne('trades', tradeRecord, (err, result) => {
                if (err || !result) {
                    logger.error(`[recordAMMTrade] Failed to record AMM trade: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        logger.debug(`[recordAMMTrade] Recorded AMM trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`);
    } catch (error) {
        logger.error(`[recordAMMTrade] Error recording AMM trade: ${error}`);
    }
}
