import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { claimFeesFromPool } from './pool-helpers.js';
import { LiquidityPoolData, PoolRemoveLiquidityData, UserLiquidityPositionData } from './pool-interfaces.js';

export async function validateTx(data: PoolRemoveLiquidityData, sender: string): Promise<boolean> {
    try {
        if (!data.poolId || data.lpTokenAmount === undefined) {
            logger.warn('[pool-remove-liquidity] Invalid data: Missing required fields (poolId, lpTokenAmount).');
            return false;
        }
        if (!validate.string(data.poolId, 64, 1)) {
            logger.warn('[pool-remove-liquidity] Invalid poolId format.');
            return false;
        }
        if (toBigInt(data.lpTokenAmount) <= toBigInt(0)) {
            logger.warn('[pool-remove-liquidity] lpTokenAmount must be a positive BigInt.');
            return false;
        }
        const pool = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as LiquidityPoolData | null;
        if (!pool) {
            logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} not found.`);
            return false;
        }
        if (pool.totalLpTokens === toBigInt(0)) {
            logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} has no liquidity to remove.`);
            return false;
        }
        const userLpPositionId = `${sender}_${data.poolId}`;
        const userPosition = (await cache.findOnePromise('userLiquidityPositions', {
            _id: userLpPositionId,
        })) as UserLiquidityPositionData | null;
        if (!userPosition) {
            logger.warn(`[pool-remove-liquidity] User ${sender} has no LP position for pool ${data.poolId}.`);
            return false;
        }
        if (toBigInt(userPosition.lpTokenBalance) < toBigInt(data.lpTokenAmount)) {
            logger.warn(
                `[pool-remove-liquidity] User ${sender} has insufficient LP token balance for pool ${data.poolId}. Has ${userPosition.lpTokenBalance}, needs ${data.lpTokenAmount}`
            );
            return false;
        }
        // TODO: Optional server-side validation for minTokenA_amount and minTokenB_amount from dataDb if needed
        return true;
    } catch (error) {
        logger.error(`[pool-remove-liquidity] Error validating data for pool ${data.poolId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: PoolRemoveLiquidityData, sender: string, transactionId: string): Promise<boolean> {
    try {
        const pool = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as LiquidityPoolData; // validateTx guarantees existence
        const userLpPositionId = `${sender}_${data.poolId}`;
        const userPosition = (await cache.findOnePromise('userLiquidityPositions', {
            _id: userLpPositionId,
        })) as UserLiquidityPositionData; // validateTx guarantees existence

        // Claim accumulated fees before removing liquidity
        const feeClaimResult = await claimFeesFromPool(sender, data.poolId, toBigInt(data.lpTokenAmount));
        if (!feeClaimResult.success) {
            logger.error(`[pool-remove-liquidity] Failed to claim fees: ${feeClaimResult.error}`);
            return false;
        }

        const tokenAAmountToReturn = (toBigInt(data.lpTokenAmount) * toBigInt(pool.tokenA_reserve)) / toBigInt(pool.totalLpTokens);
        const tokenBAmountToReturn = (toBigInt(data.lpTokenAmount) * toBigInt(pool.tokenB_reserve)) / toBigInt(pool.totalLpTokens);

        if (tokenAAmountToReturn <= toBigInt(0) || tokenBAmountToReturn <= toBigInt(0)) {
            logger.error(`[pool-remove-liquidity] Calculated zero or negative tokens to return for ${data.poolId}.`);
            return false;
        }

        // Update pool reserves
        const poolUpdateSuccess = await cache.updateOnePromise(
            'liquidityPools',
            { _id: data.poolId },
            {
                $set: {
                    tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) - tokenAAmountToReturn),
                    tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) - tokenBAmountToReturn),
                    totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) - toBigInt(data.lpTokenAmount)),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );

        if (!poolUpdateSuccess) {
            logger.error(`[pool-remove-liquidity] Failed to update pool reserves for ${data.poolId}.`);
            return false;
        }

        // Update user LP position
        const newLpBalance = toBigInt(userPosition.lpTokenBalance) - toBigInt(data.lpTokenAmount);
        const userPositionUpdateSuccess = await cache.updateOnePromise(
            'userLiquidityPositions',
            { _id: userLpPositionId },
            {
                $set: {
                    lpTokenBalance: toDbString(newLpBalance),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );

        if (!userPositionUpdateSuccess) {
            logger.error(`[pool-remove-liquidity] CRITICAL: Failed to update user LP position ${userLpPositionId}.`);
            return false;
        }

        // After updating userLiquidityPositions, debit LP tokens from user account
        const lpTokenSymbol = getLpTokenSymbol(pool.tokenA_symbol, pool.tokenB_symbol);
        const debitLPSuccess = await adjustUserBalance(sender, lpTokenSymbol, -toBigInt(data.lpTokenAmount));
        if (!debitLPSuccess) {
            logger.error(`[pool-remove-liquidity] Failed to debit LP tokens (${lpTokenSymbol}) from ${sender}.`);
            return false;
        }

        // Credit the user's account with the withdrawn tokens
        const creditASuccess = await adjustUserBalance(sender, pool.tokenA_symbol, tokenAAmountToReturn);
        if (!creditASuccess) {
            logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${tokenAAmountToReturn} ${pool.tokenA_symbol} to ${sender}.`);
            return false;
        }

        const creditBSuccess = await adjustUserBalance(sender, pool.tokenB_symbol, tokenBAmountToReturn);
        if (!creditBSuccess) {
            logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${tokenBAmountToReturn} ${pool.tokenB_symbol} to ${sender}.`);
            return false;
        }

        logger.debug(
            `[pool-remove-liquidity] ${sender} removed liquidity from pool ${data.poolId} by burning ${data.lpTokenAmount} LP tokens. Received ${tokenAAmountToReturn} ${pool.tokenA_symbol} and ${tokenBAmountToReturn} ${pool.tokenB_symbol}. Claimed fees: ${feeClaimResult.feesClaimedA} ${pool.tokenA_symbol} and ${feeClaimResult.feesClaimedB} ${pool.tokenB_symbol}.`
        );

        // Log event
        await logEvent(
            'defi',
            'liquidity_removed',
            sender,
            {
                poolId: data.poolId,
                tokenAAmount: toDbString(tokenAAmountToReturn),
                tokenBAmount: toDbString(tokenBAmountToReturn),
                lpTokensBurned: toDbString(data.lpTokenAmount),
                feesClaimedA: feeClaimResult.feesClaimedA.toString(),
                feesClaimedB: feeClaimResult.feesClaimedB.toString(),
            },
            transactionId
        );

        return true;
    } catch (error) {
        logger.error(`[pool-remove-liquidity] Error processing remove liquidity for pool ${data.poolId} by ${sender}: ${error}`);
        return false;
    }
}
