import crypto from 'crypto';

import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { calculateDecimalAwarePrice, formatTokenAmount, toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { LiquidityPoolData, UserLiquidityPositionData } from './pool-interfaces.js';

export async function createLiquidityPool(poolId: string, tokenA_symbol: string, tokenB_symbol: string): Promise<boolean> {
    try {
        const poolDocument: LiquidityPoolData = {
            _id: poolId,
            tokenA_symbol,
            tokenA_reserve: toDbString(0),
            tokenB_symbol,
            tokenB_reserve: toDbString(0),
            totalLpTokens: toDbString(0),
            createdAt: new Date().toISOString(),
            status: 'ACTIVE',
        };
        const createSuccess = await cache.insertOnePromise('liquidityPools', poolDocument);
        if (!createSuccess) {
            logger.error(`[pool-helpers] Failed to create liquidity pool ${poolId}`);
            return false;
        }
        logger.debug(`[pool-helpers] Liquidity Pool ${poolId} (${tokenA_symbol}_${tokenB_symbol}) created successfully`);
        return true;
    } catch (error) {
        logger.error(`[pool-helpers] Error creating liquidity pool ${poolId}: ${error}`);
        return false;
    }
}

export async function createLpToken(tokenA_symbol: string, tokenB_symbol: string, poolId: string): Promise<boolean> {
    try {
        const lpTokenSymbol = getLpTokenSymbol(tokenA_symbol, tokenB_symbol);
        const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
        if (existingLpToken) {
            logger.debug(`[pool-helpers] LP token ${lpTokenSymbol} already exists`);
            return true;
        }
        const lpToken = {
            _id: lpTokenSymbol,
            symbol: lpTokenSymbol,
            name: `LP Token for ${tokenA_symbol}_${tokenB_symbol}`,
            issuer: 'null',
            precision: 18,
            maxSupply: toDbString(config.maxValue),
            currentSupply: toDbString(0),
            mintable: false,
            burnable: false,
            description: `Liquidity provider token for pool ${poolId}`,
            createdAt: new Date().toISOString(),
        };
        const lpTokenSuccess = await cache.insertOnePromise('tokens', lpToken);
        if (!lpTokenSuccess) {
            logger.error(`[pool-helpers] Failed to create LP token ${lpTokenSymbol}`);
            return false;
        }
        logger.debug(`[pool-helpers] Created LP token ${lpTokenSymbol} for pool ${poolId}`);
        return true;
    } catch (error) {
        logger.error(`[pool-helpers] Error creating LP token for pool ${poolId}: ${error}`);
        return false;
    }
}

export async function createTradingPair(poolId: string, tokenA_symbol: string, tokenB_symbol: string, sender: string, transactionId: string): Promise<boolean> {
    try {
        const maxTradeAmount = toBigInt(config.maxValue) / toBigInt(1000);
        const tradingPairDocument = {
            _id: poolId,
            baseAssetSymbol: tokenA_symbol,
            quoteAssetSymbol: tokenB_symbol,
            tickSize: toDbString(1),
            lotSize: toDbString(1),
            minNotional: toDbString(1),
            status: 'TRADING',
            minTradeAmount: toDbString(1),
            maxTradeAmount: toDbString(maxTradeAmount),
            createdAt: new Date().toISOString(),
        };

        const pairInsertSuccess = await cache.insertOnePromise('tradingPairs', tradingPairDocument);
        if (!pairInsertSuccess) {
            logger.warn(`[pool-helpers] Failed to create trading pair ${poolId}`);
            return false;
        }
        logger.debug(`[pool-helpers] Created trading pair ${poolId} for pool`);
        await logEvent(
            'market',
            'pair_created',
            sender,
            {
                pairId: poolId,
                baseAssetSymbol: tokenA_symbol,
                quoteAssetSymbol: tokenB_symbol,
                initialStatus: 'TRADING',
                createdAt: new Date().toISOString(),
                autoCreated: true,
                poolId: poolId,
            },
            transactionId
        );
        return true;
    } catch (error) {
        logger.error(`[pool-helpers] Error creating trading pair for pool ${poolId}: ${error}`);
        return false;
    }
}

export async function debitLiquidityTokens(
    user: string,
    tokenASymbol: string,
    tokenBSymbol: string,
    tokenAAmount: string | bigint,
    tokenBAmount: string | bigint
): Promise<boolean> {
    const debitASuccess = await adjustUserBalance(user, tokenASymbol, -toBigInt(tokenAAmount));
    const debitBSuccess = await adjustUserBalance(user, tokenBSymbol, -toBigInt(tokenBAmount));
    if (!debitASuccess || !debitBSuccess) {
        logger.error(`[pool-helpers] Failed to debit tokens from ${user}.`);
        return false;
    }
    return true;
}

export async function updatePoolReserves(
    poolId: string,
    pool: LiquidityPoolData,
    tokenAAmount: string | bigint,
    tokenBAmount: string | bigint,
    lpTokensToMint: bigint
): Promise<boolean> {
    const isInitialLiquidity = toBigInt(pool.totalLpTokens) === toBigInt(0);
    let minimumLiquidityBurned = toBigInt(0);
    if (isInitialLiquidity) {
        const BASE_MINIMUM = toBigInt(1000);
        const totalLiquidity = lpTokensToMint + BASE_MINIMUM;
        const ADAPTIVE_MINIMUM = totalLiquidity / toBigInt(1000);
        minimumLiquidityBurned = ADAPTIVE_MINIMUM > toBigInt(0) && ADAPTIVE_MINIMUM < BASE_MINIMUM ? ADAPTIVE_MINIMUM : BASE_MINIMUM;
    }
    const totalLpTokensToAdd = isInitialLiquidity ? lpTokensToMint + minimumLiquidityBurned : lpTokensToMint;
    const poolUpdateSuccess = await cache.updateOnePromise(
        'liquidityPools',
        { _id: poolId },
        {
            $set: {
                tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) + toBigInt(tokenAAmount)),
                tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) + toBigInt(tokenBAmount)),
                totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) + totalLpTokensToAdd),
                feeGrowthGlobalA: toDbString(pool.feeGrowthGlobalA || '0'),
                feeGrowthGlobalB: toDbString(pool.feeGrowthGlobalB || '0'),
                lastUpdatedAt: new Date().toISOString(),
            },
        }
    );
    if (!poolUpdateSuccess) {
        logger.error(`[pool-helpers] Failed to update pool ${poolId}. Add liquidity aborted.`);
        return false;
    }
    return true;
}

export async function updateUserLiquidityPosition(user: string, poolId: string, lpTokensToMint: bigint, pool: LiquidityPoolData): Promise<boolean> {
    const userPositionId = `${user}_${poolId}`;
    const existingUserPosDB = (await cache.findOnePromise('userLiquidityPositions', {
        _id: userPositionId,
    })) as UserLiquidityPositionData | null;
    const existingUserPos = existingUserPosDB
        ? {
              ...existingUserPosDB,
              lpTokenBalance: toBigInt(existingUserPosDB.lpTokenBalance),
              feeGrowthEntryA: toBigInt(existingUserPosDB.feeGrowthEntryA || '0'),
              feeGrowthEntryB: toBigInt(existingUserPosDB.feeGrowthEntryB || '0'),
          }
        : null;
    let userPosUpdateSuccess = false;
    if (existingUserPos) {
        userPosUpdateSuccess = await cache.updateOnePromise(
            'userLiquidityPositions',
            { _id: userPositionId },
            {
                $set: {
                    lpTokenBalance: toDbString(existingUserPos.lpTokenBalance + lpTokensToMint),
                    feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || 0),
                    feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || 0),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );
    } else {
        const newUserPosition: UserLiquidityPositionData = {
            _id: userPositionId,
            user,
            poolId,
            lpTokenBalance: toDbString(lpTokensToMint),
            feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || 0),
            feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || 0),
            createdAt: new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
        };
        userPosUpdateSuccess = await new Promise<boolean>(resolve => {
            cache.insertOne('userLiquidityPositions', newUserPosition, (err, success) => {
                if (err || !success) {
                    logger.error(`[pool-helpers] Failed to insert new user position ${userPositionId}: ${err || 'insert not successful'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
    if (!userPosUpdateSuccess) {
        logger.error(`[pool-helpers] CRITICAL: Failed to update user position.`);
        return false;
    }
    return true;
}

export async function creditLpTokens(user: string, tokenASymbol: string, tokenBSymbol: string, lpTokensToMint: bigint, poolId: string): Promise<boolean> {
    const lpTokenSymbol = getLpTokenSymbol(tokenASymbol, tokenBSymbol);
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (!existingLpToken) {
        logger.error(`[pool-helpers] LP token ${lpTokenSymbol} does not exist for pool ${poolId}. This should be created during pool creation.`);
        return false;
    }
    const creditLPSuccess = await adjustUserBalance(user, lpTokenSymbol, lpTokensToMint);
    if (!creditLPSuccess) {
        logger.error(`[pool-helpers] Failed to credit LP tokens (${lpTokenSymbol}) to ${user}.`);
        return false;
    }
    return true;
}

export async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
    const patterns = [`${tokenA}_${tokenB}`, `${tokenB}_${tokenA}`];
    for (const pairId of patterns) {
        const tradingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (tradingPair) {
            return pairId;
        }
    }
    return null;
}

export async function recordPoolSwapTrade(params: {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
    sender: string;
    transactionId: string;
    feeAmount?: bigint | string;
}): Promise<void> {
    try {
        const pairId = await findTradingPairId(params.tokenIn, params.tokenOut);
        if (!pairId) {
            logger.debug(`[pool-swap] No trading pair found for ${params.tokenIn}_${params.tokenOut}, skipping trade record`);
            return;
        }

        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            logger.warn(`[pool-swap] Trading pair ${pairId} not found, using token symbols as-is`);
        }

        let baseSymbol, quoteSymbol, tradeSide: 'BUY' | 'SELL';
        let buyerUserId: string;
        let sellerUserId: string;
        let quantity: bigint;
        let volume: bigint;
        let price: bigint;

        if (pair) {
            baseSymbol = pair.baseAssetSymbol;
            quoteSymbol = pair.quoteAssetSymbol;

            if (params.tokenOut === baseSymbol) {
                tradeSide = 'BUY';
                buyerUserId = params.sender;
                sellerUserId = 'POOL';
                quantity = params.amountOut;
                volume = params.amountIn;

                price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            } else if (params.tokenIn === baseSymbol) {
                tradeSide = 'SELL';
                buyerUserId = 'POOL';
                sellerUserId = params.sender;
                quantity = params.amountIn;
                volume = params.amountOut;

                price = calculateDecimalAwarePrice(params.amountOut, params.amountIn, quoteSymbol, baseSymbol);
            } else {
                logger.warn(`[pool-swap] Could not determine trade side for ${params.tokenIn} -> ${params.tokenOut}, defaulting to buy`);
                tradeSide = 'BUY';
                buyerUserId = params.sender;
                sellerUserId = 'POOL';
                quantity = params.amountOut;
                volume = params.amountIn;
                price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            }
        } else {
            baseSymbol = params.tokenOut;
            quoteSymbol = params.tokenIn;
            tradeSide = 'BUY';
            buyerUserId = params.sender;
            sellerUserId = 'POOL';
            quantity = params.amountOut;
            volume = params.amountIn;
            price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
        }

        const tradeId = crypto
            .createHash('sha256')
            .update(`${pairId}_${params.tokenIn}_${params.tokenOut}_${params.sender}_${params.transactionId}_${params.amountOut}`)
            .digest('hex')
            .substring(0, 16);
        const tradeRecord = {
            _id: tradeId,
            pairId: pairId,
            baseAssetSymbol: baseSymbol,
            quoteAssetSymbol: quoteSymbol,
            makerOrderId: null,
            takerOrderId: null,
            buyerUserId: buyerUserId,
            sellerUserId: sellerUserId,
            price: toDbString(price),
            quantity: toDbString(quantity),
            volume: toDbString(volume),
            timestamp: new Date().toISOString(),
            side: tradeSide,
            type: 'market',
            source: 'pool',
            isMakerBuyer: false,
            feeAmount: params.feeAmount !== undefined ? toDbString(params.feeAmount) : '0',
            feeCurrency: quoteSymbol,
            makerFee: '0',
            takerFee: '0',
            total: toDbString(volume),
        };

        await new Promise<void>((resolve, reject) => {
            cache.insertOne('trades', tradeRecord, (err, result) => {
                if (err || !result) {
                    logger.error(`[pool-swap] Failed to record trade: ${err}`);
                    logger.error(`[pool-swap] Trade record that failed:`, JSON.stringify(tradeRecord, null, 2));
                    reject(err);
                } else {
                    logger.debug(`[pool-swap] Successfully recorded trade ${tradeRecord._id}`);
                    resolve();
                }
            });
        });

        try {
            const formattedIn = formatTokenAmount(params.amountIn, params.tokenIn);
            const formattedOut = formatTokenAmount(params.amountOut, params.tokenOut);
            logger.debug(
                `[pool-swap] Recorded trade: ${params.amountIn} (${formattedIn} ${params.tokenIn}) -> ${params.amountOut} (${formattedOut} ${params.tokenOut}) via pool ${params.poolId}`
            );
        } catch (e) {
            // Fallback to raw values if formatting fails for any reason
            logger.debug(`[pool-swap] Could not format token amounts for logging, using raw values ${e}`);
            logger.debug(
                `[pool-swap] Recorded trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`
            );
        }
    } catch (error) {
        logger.error(`[pool-swap] Error recording trade: ${error}`);
    }
}

/**
 * Claims accumulated fees from a user's liquidity position
 * This function can be used by both pool-claim-fees and pool-remove-liquidity
 */
export async function claimFeesFromPool(
    user: string,
    poolId: string,
    lpTokenAmount?: bigint
): Promise<{ success: boolean; feesClaimedA: bigint; feesClaimedB: bigint; error?: string }> {
    try {
        const pool = (await cache.findOnePromise('liquidityPools', { _id: poolId })) as LiquidityPoolData | null;
        if (!pool) {
            return {
                success: false,
                feesClaimedA: toBigInt(0),
                feesClaimedB: toBigInt(0),
                error: `Pool ${poolId} not found`,
            };
        }

        const userPositionId = `${user}_${poolId}`;
        const userPosition = (await cache.findOnePromise('userLiquidityPositions', {
            _id: userPositionId,
        })) as UserLiquidityPositionData | null;
        if (!userPosition) {
            return {
                success: false,
                feesClaimedA: toBigInt(0),
                feesClaimedB: toBigInt(0),
                error: `User ${user} has no position in pool ${poolId}`,
            };
        }

        const currentFeeGrowthA = toBigInt(pool.feeGrowthGlobalA || '0');
        const currentFeeGrowthB = toBigInt(pool.feeGrowthGlobalB || '0');
        const userFeeGrowthEntryA = toBigInt(userPosition.feeGrowthEntryA || '0');
        const userFeeGrowthEntryB = toBigInt(userPosition.feeGrowthEntryB || '0');
        const deltaA = currentFeeGrowthA - userFeeGrowthEntryA;
        const deltaB = currentFeeGrowthB - userFeeGrowthEntryB;

        const lpTokensToCalculate = lpTokenAmount || toBigInt(userPosition.lpTokenBalance);

        const claimableFeesA = (deltaA * lpTokensToCalculate) / toBigInt(1e18);
        const claimableFeesB = (deltaB * lpTokensToCalculate) / toBigInt(1e18);

        if (claimableFeesA <= toBigInt(0) && claimableFeesB <= toBigInt(0)) {
            return { success: true, feesClaimedA: toBigInt(0), feesClaimedB: toBigInt(0) };
        }

        if (claimableFeesA > toBigInt(0)) {
            const creditASuccess = await adjustUserBalance(user, pool.tokenA_symbol, claimableFeesA);
            if (!creditASuccess) {
                return {
                    success: false,
                    feesClaimedA: toBigInt(0),
                    feesClaimedB: toBigInt(0),
                    error: `Failed to credit ${claimableFeesA} ${pool.tokenA_symbol} to ${user}`,
                };
            }
        }

        if (claimableFeesB > toBigInt(0)) {
            const creditBSuccess = await adjustUserBalance(user, pool.tokenB_symbol, claimableFeesB);
            if (!creditBSuccess) {
                return {
                    success: false,
                    feesClaimedA: toBigInt(0),
                    feesClaimedB: toBigInt(0),
                    error: `Failed to credit ${claimableFeesB} ${pool.tokenB_symbol} to ${user}`,
                };
            }
        }

        const updateSuccess = await cache.updateOnePromise(
            'userLiquidityPositions',
            { _id: userPositionId },
            {
                $set: {
                    feeGrowthEntryA: toDbString(currentFeeGrowthA),
                    feeGrowthEntryB: toDbString(currentFeeGrowthB),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );

        if (!updateSuccess) {
            logger.error(`[claimFeesFromPool] Failed to update user position for ${user} in pool ${poolId}`);
            return {
                success: false,
                feesClaimedA: toBigInt(0),
                feesClaimedB: toBigInt(0),
                error: 'Failed to update user position',
            };
        }

        logger.debug(
            `[claimFeesFromPool] User ${user} claimed ${claimableFeesA} ${pool.tokenA_symbol} and ${claimableFeesB} ${pool.tokenB_symbol} from pool ${poolId}`
        );

        return {
            success: true,
            feesClaimedA: claimableFeesA,
            feesClaimedB: claimableFeesB,
        };
    } catch (error) {
        logger.error(`[claimFeesFromPool] Error claiming fees for ${user} from pool ${poolId}: ${error}`);
        return {
            success: false,
            feesClaimedA: toBigInt(0),
            feesClaimedB: toBigInt(0),
            error: `Claim fees error: ${error}`,
        };
    }
}
