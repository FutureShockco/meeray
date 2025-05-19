import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmStakeData, Farm, UserFarmPosition } from './farm-interfaces.js';
import { UserLiquidityPosition } from '../pool/pool-interfaces.js'; // For checking LP token balance
import { getAccount } from '../../utils/account-utils.js';

export async function validateTx(data: FarmStakeData, sender: string): Promise<boolean> {
  try {
    if (!data.farmId || !data.staker || data.lpTokenAmount === undefined) {
      logger.warn('[farm-stake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
      return false;
    }
    if (sender !== data.staker) {
      logger.warn('[farm-stake] Sender must be the staker.');
      return false;
    }
    if (!validate.string(data.farmId, 64, 1)) { // farmId format check (e.g., farm-hash)
        logger.warn('[farm-stake] Invalid farmId format.');
        return false;
    }
    if (!validate.integer(data.lpTokenAmount, false, false, undefined, 0) || data.lpTokenAmount <= 0) {
        logger.warn('[farm-stake] lpTokenAmount must be a positive number.');
        return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.warn(`[farm-stake] Farm ${data.farmId} not found.`);
      return false;
    }

    // The farm.lpTokenIssuer is assumed to be the poolId where these LP tokens originate
    const poolIdForLp = farm.lpTokenIssuer;
    const userLpPositionId = `${data.staker}-${poolIdForLp}`;
    const userLiquidityPos = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPosition | null;

    if (!userLiquidityPos || userLiquidityPos.lpTokenBalance < data.lpTokenAmount) {
      logger.warn(`[farm-stake] Staker ${data.staker} has insufficient LP token balance for pool ${poolIdForLp} (LP tokens for farm ${data.farmId}). Has ${userLiquidityPos?.lpTokenBalance || 0}, needs ${data.lpTokenAmount}`);
      return false;
    }

    const stakerAccount = await getAccount(data.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-stake] Staker account ${data.staker} not found.`);
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error(`[farm-stake] Error validating stake data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmStakeData, sender: string): Promise<boolean> {
  try {
    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.error(`[farm-stake] CRITICAL: Farm ${data.farmId} not found during processing.`);
      return false;
    }

    const poolIdForLp = farm.lpTokenIssuer;
    const userLpSourcePositionId = `${data.staker}-${poolIdForLp}`;
    const userLiquidityPos = await cache.findOnePromise('userLiquidityPositions', { _id: userLpSourcePositionId }) as UserLiquidityPosition | null;

    if (!userLiquidityPos || userLiquidityPos.lpTokenBalance < data.lpTokenAmount) {
      logger.error(`[farm-stake] CRITICAL: Staker ${data.staker} has insufficient LP balance for ${poolIdForLp} during processing.`);
      return false;
    }

    // 1. Decrease LP token balance from UserLiquidityPosition
    const newLpBalanceInPool = userLiquidityPos.lpTokenBalance - data.lpTokenAmount;
    const lpBalanceUpdateSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpSourcePositionId },
        { $set: { lpTokenBalance: newLpBalanceInPool, lastUpdatedAt: new Date().toISOString() } }
    );

    if (!lpBalanceUpdateSuccess) {
        logger.error(`[farm-stake] Failed to update LP token balance for ${userLpSourcePositionId}. Staking aborted.`);
        return false;
    }

    // 2. Increase totalLpStaked in the Farm document
    const farmUpdateSuccess = await cache.updateOnePromise(
        'farms',
        { _id: data.farmId },
        { 
            $inc: { totalLpStaked: data.lpTokenAmount },
            $set: { lastUpdatedAt: new Date().toISOString() } // Assuming Farm has lastUpdatedAt
        }
    );

    if (!farmUpdateSuccess) {
        logger.error(`[farm-stake] CRITICAL: Failed to update totalLpStaked for farm ${data.farmId}. Rolling back LP balance deduction for ${userLpSourcePositionId}.`);
        await cache.updateOnePromise('userLiquidityPositions', { _id: userLpSourcePositionId }, { $set: { lpTokenBalance: userLiquidityPos.lpTokenBalance }}); // Rollback
        return false;
    }

    // 3. Create or update UserFarmPosition
    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    let userFarmPosUpdateSuccess = false;

    const existingUserFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPosition | null;

    if (existingUserFarmPos) {
        // Update existing position
        userFarmPosUpdateSuccess = await cache.updateOnePromise(
            'userFarmPositions',
            { _id: userFarmPositionId },
            {
                $inc: { stakedLpAmount: data.lpTokenAmount },
                $set: { lastStakedAt: new Date().toISOString() }
            }
        );
    } else {
        // Create new position
        const newUserFarmPosition: UserFarmPosition = {
            _id: userFarmPositionId,
            staker: data.staker,
            farmId: data.farmId,
            stakedLpAmount: data.lpTokenAmount,
            createdAt: new Date().toISOString(),
            lastStakedAt: new Date().toISOString() // Also set lastStakedAt on creation
        };
        // insertOne callback expects (err, result) where result is boolean for success
        userFarmPosUpdateSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('userFarmPositions', newUserFarmPosition, (err, success) => {
                if (err || !success) {
                    logger.error(`[farm-stake] Failed to insert new user farm position ${userFarmPositionId}: ${err || 'insert not successful'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    if (!userFarmPosUpdateSuccess) {
        logger.error(`[farm-stake] CRITICAL: Failed to update user farm position ${userFarmPositionId}. Farm total updated. Attempting to roll back farm total and user LP balance.`);
        // Rollback farm total
        await cache.updateOnePromise('farms', { _id: data.farmId }, { $inc: { totalLpStaked: -data.lpTokenAmount }});
        // Rollback LP balance deduction
        await cache.updateOnePromise('userLiquidityPositions', { _id: userLpSourcePositionId }, { $set: { lpTokenBalance: userLiquidityPos.lpTokenBalance }});
        return false;
    }

    logger.info(`[farm-stake] Staker ${data.staker} staked ${data.lpTokenAmount} LP tokens (from pool ${poolIdForLp}) into farm ${data.farmId}.`);

    const eventDocument = {
      type: 'farmStake',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        farmId: data.farmId,
        staker: data.staker,
        lpTokenSymbol: farm.lpTokenSymbol, // For richer event data
        lpTokenIssuer: farm.lpTokenIssuer, // poolId
        lpTokenAmount: data.lpTokenAmount
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[farm-stake] CRITICAL: Failed to log farmStake event for ${data.farmId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[farm-stake] Error processing stake for farm ${data.farmId} by ${sender}: ${error}`);
    // Complex rollbacks might be needed depending on where the error occurred.
    // The individual steps above attempt some rollbacks.
    return false;
  }
} 