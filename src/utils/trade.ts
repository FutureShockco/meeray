import crypto from 'crypto';

import cache from '../cache.js';
import logger from '../logger.js';
import { OrderSide } from '../transactions/market/market-interfaces.js';
import { calculateDecimalAwarePrice, getTokenDecimals, toBigInt, toDbString } from './bigint.js';

export async function determineOrderSide(tokenIn: string, tokenOut: string, pairId: string): Promise<OrderSide> {
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
        throw new Error(`Trading pair ${pairId} not found`);
    }
    const baseAsset = pair.baseAssetSymbol;
    if (tokenOut === baseAsset) {
        return OrderSide.BUY;
    } else if (tokenIn === baseAsset) {
        return OrderSide.SELL;
    } else {
        throw new Error(`Invalid trade direction for pair ${pairId}: ${tokenIn} → ${tokenOut}`);
    }
}

export async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
    const pairId1 = `${tokenA}_${tokenB}`;
    const pairId2 = `${tokenB}_${tokenA}`;
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
        const pairId = await findTradingPairId(params.tokenIn, params.tokenOut);
        if (!pairId) {
            logger.warn(`[recordAMMTrade] No trading pair found for ${params.tokenIn}_${params.tokenOut}, skipping trade record`);
            return;
        }
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            logger.warn(`[recordAMMTrade] Trading pair ${pairId} not found, using token symbols as-is`);
        }
        let baseSymbol, quoteSymbol, quantity, volume, priceValue;
        if (pair) {
            baseSymbol = pair.baseAssetSymbol;
            quoteSymbol = pair.quoteAssetSymbol;
            if (params.tokenOut === baseSymbol) {
                quantity = params.amountOut;
                volume = params.amountIn;
                priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            } else {
                quantity = params.amountIn;
                volume = params.amountOut;
                priceValue = calculateDecimalAwarePrice(params.amountOut, params.amountIn, quoteSymbol, baseSymbol);
            }
        } else {
            baseSymbol = params.tokenOut;
            quoteSymbol = params.tokenIn;
            quantity = params.amountOut;
            volume = params.amountIn;
            priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
        }
        if (priceValue === 0n && quantity > 0n && volume > 0n) {
            const tokenInDecimals = getTokenDecimals(params.tokenIn);
            const tokenOutDecimals = getTokenDecimals(params.tokenOut);
            const decimalDifference = tokenOutDecimals - tokenInDecimals;
            if (decimalDifference >= 0) {
                const scalingFactor = toBigInt(10 ** decimalDifference);
                const quoteDecimals = getTokenDecimals(quoteSymbol);
                priceValue = (volume * scalingFactor * toBigInt(10 ** quoteDecimals)) / quantity;
            } else {
                const scalingFactor = toBigInt(10 ** -decimalDifference);
                const quoteDecimals = getTokenDecimals(quoteSymbol);
                priceValue = (volume * toBigInt(10 ** quoteDecimals)) / (quantity * scalingFactor);
            }
            if (priceValue < 0n) {
                logger.error(`[recordAMMTrade] CRITICAL: Negative price calculated in fallback! Using 0 instead.`);
                priceValue = 0n;
            }
            logger.warn(
                `[recordAMMTrade] Price was 0, using corrected calculation: ${priceValue} for ${volume} ${quoteSymbol}/${quantity} ${baseSymbol} (decimals: ${tokenInDecimals}/${tokenOutDecimals})`
            );
        }
        logger.info(`[recordAMMTrade] Trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut}`);
        logger.info(`[recordAMMTrade] Mapped: ${quantity} ${baseSymbol} (quantity), ${volume} ${quoteSymbol} (volume), price: ${priceValue}`);
        logger.info(`[recordAMMTrade] Pair: ${pairId}, Base: ${baseSymbol}, Quote: ${quoteSymbol}`);
        if (priceValue === 0n) {
            logger.error(`[recordAMMTrade] CRITICAL: Price is still 0 after all calculations!`);
            logger.error(`[recordAMMTrade] Input: ${params.amountIn} ${params.tokenIn}, Output: ${params.amountOut} ${params.tokenOut}`);
            logger.error(`[recordAMMTrade] Quantity: ${quantity}, Volume: ${volume}`);
        }
        if (priceValue < 0n) {
            logger.error(`[recordAMMTrade] CRITICAL: Final price is negative! Setting to 0. Price: ${priceValue}`);
            priceValue = 0n;
        }
        let tradeSide: 'BUY' | 'SELL';
        let buyerUserId: string;
        let sellerUserId: string;
        if (params.tokenOut === baseSymbol) {
            tradeSide = 'BUY';
            buyerUserId = params.sender;
            sellerUserId = 'AMM';
        } else if (params.tokenIn === baseSymbol) {
            tradeSide = 'SELL';
            buyerUserId = 'AMM';
            sellerUserId = params.sender;
        } else {
            logger.warn(`[recordAMMTrade] Could not determine trade side for ${params.tokenIn} -> ${params.tokenOut}, defaulting to buy`);
            tradeSide = 'BUY';
            buyerUserId = params.sender;
            sellerUserId = 'AMM';
        }

        const tradeId = crypto
            .createHash('sha256')
            .update(`${pairId}_${params.tokenIn}_${params.tokenOut}_${params.sender}_${params.transactionId}_${params.amountOut}`)
            .digest('hex')
            .substring(0, 16);

        logger.debug(`[recordAMMTrade] Generated trade ID: ${tradeId}`);
        logger.debug(`[recordAMMTrade] Price value: ${priceValue}, Quantity: ${quantity}, Volume: ${volume}`);
        const tradeRecord = {
            _id: tradeId,
            pairId: pairId,
            baseAssetSymbol: baseSymbol,
            quoteAssetSymbol: quoteSymbol,
            makerOrderId: null, // AMM trades don't have maker orders
            takerOrderId: null, // AMM trades don't have taker orders
            buyerUserId: buyerUserId,
            sellerUserId: sellerUserId,
            price: toDbString(priceValue),
            quantity: toDbString(quantity),
            volume: toDbString(volume),
            timestamp: new Date().toISOString(),
            side: tradeSide,
            type: 'market', // AMM trades are market orders
            source: 'pool',
            isMakerBuyer: false,
            feeAmount: '0', // Fees are handled in the pool swap
            feeCurrency: quoteSymbol,
            makerFee: '0',
            takerFee: '0',
            total: toDbString(volume),
        };
        logger.debug(`[recordAMMTrade] Trade record created: ${JSON.stringify(tradeRecord, null, 2)}`);
        await new Promise<void>((resolve, reject) => {
            cache.insertOne('trades', tradeRecord, (err, result) => {
                logger.debug(`[recordAMMTrade] Cache insertOne callback - err: ${err}, result: ${result}`);
                if (err) {
                    logger.error(`[recordAMMTrade] Database error recording AMM trade: ${err}`);
                    reject(err);
                } else if (!result) {
                    logger.warn(`[recordAMMTrade] Trade record already exists (duplicate), skipping insertion`);
                    resolve();
                } else {
                    logger.debug(`[recordAMMTrade] Successfully recorded AMM trade`);
                    resolve();
                }
            });
        });
        logger.debug(
            `[recordAMMTrade] Recorded AMM trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`
        );
    } catch (error) {
        logger.error(`[recordAMMTrade] Error recording AMM trade: ${error}`);
    }
}
