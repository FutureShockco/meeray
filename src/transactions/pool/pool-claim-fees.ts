import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { claimFeesFromPool } from './pool-helpers.js';
import { LiquidityPoolData, UserLiquidityPositionData } from './pool-interfaces.js';

export interface PoolClaimFeesData {
    poolId: string; // Identifier of the liquidity pool
}

export async function validateTx(data: PoolClaimFeesData, sender: string): Promise<boolean> {
    try {
        if (!data.poolId) {
            logger.warn('[pool-claim-fees] Invalid data: Missing required field (poolId).');
            return false;
        }

        if (!validate.string(data.poolId, 64, 1)) {
            logger.warn('[pool-claim-fees] Invalid poolId format.');
            return false;
        }

        // Check if pool exists
        const pool = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as LiquidityPoolData | null;
        if (!pool) {
            logger.warn(`[pool-claim-fees] Pool ${data.poolId} not found.`);
            return false;
        }

        // Check if user has a position in this pool
        const userPositionId = `${sender}_${data.poolId}`;
        const userPosition = (await cache.findOnePromise('userLiquidityPositions', {
            _id: userPositionId,
        })) as UserLiquidityPositionData | null;
        if (!userPosition) {
            logger.warn(`[pool-claim-fees] User ${sender} has no position in pool ${data.poolId}.`);
            return false;
        }

        // Check if user has any LP tokens
        if (toBigInt(userPosition.lpTokenBalance) <= toBigInt(0)) {
            logger.warn(`[pool-claim-fees] User ${sender} has no LP tokens in pool ${data.poolId}.`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[pool-claim-fees] Error validating data for pool ${data.poolId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: PoolClaimFeesData, sender: string, transactionId: string): Promise<boolean> {
    try {
        logger.debug(`[pool-claim-fees] Processing fee claim for user ${sender} from pool ${data.poolId}`);

        // Claim fees using the reusable function
        const result = await claimFeesFromPool(sender, data.poolId);

        if (!result.success) {
            logger.error(`[pool-claim-fees] Failed to claim fees: ${result.error}`);
            return false;
        }

        // If no fees were claimed, that's still a successful transaction
        if (result.feesClaimedA <= toBigInt(0) && result.feesClaimedB <= toBigInt(0)) {
            logger.debug(`[pool-claim-fees] User ${sender} has no fees to claim from pool ${data.poolId}`);
            return true;
        }

        // Get pool data for logging
        const pool = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as LiquidityPoolData;

        // Log event
        await logEvent(
            'defi',
            'fees_claimed',
            sender,
            {
                poolId: data.poolId,
                tokenA: pool.tokenA_symbol,
                tokenB: pool.tokenB_symbol,
                feesClaimedA: result.feesClaimedA.toString(),
                feesClaimedB: result.feesClaimedB.toString(),
            },
            transactionId
        );

        logger.debug(
            `[pool-claim-fees] User ${sender} successfully claimed ${result.feesClaimedA} ${pool.tokenA_symbol} and ${result.feesClaimedB} ${pool.tokenB_symbol} from pool ${data.poolId}`
        );

        return true;
    } catch (error) {
        logger.error(`[pool-claim-fees] Error processing fee claim for pool ${data.poolId} by ${sender}: ${error}`);
        return false;
    }
}
