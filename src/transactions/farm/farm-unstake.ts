import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmUnstakeData, Farm, UserFarmPosition } from './farm-interfaces.js';
import { UserLiquidityPosition } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account-utils.js';

export async function validateTx(data: FarmUnstakeData, sender: string): Promise<boolean> {
  try {
    if (!data.farmId || !data.staker || data.lpTokenAmount === undefined) {
      logger.warn('[farm-unstake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
      return false;
    }
    if (sender !== data.staker) {
      logger.warn('[farm-unstake] Sender must be the staker.');
      return false;
    }
    if (!validate.string(data.farmId, 64, 1)) {
        logger.warn('[farm-unstake] Invalid farmId format.');
        return false;
    }
    if (!validate.integer(data.lpTokenAmount, false, false, undefined, 0) || data.lpTokenAmount <= 0) {
        logger.warn('[farm-unstake] lpTokenAmount must be a positive number.');
        return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.warn(`[farm-unstake] Farm ${data.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPosition | null;
    if (!userFarmPos || userFarmPos.stakedLpAmount < data.lpTokenAmount) {
      logger.warn(`[farm-unstake] Staker ${data.staker} has insufficient staked LP token balance in farm ${data.farmId}. Has ${userFarmPos?.stakedLpAmount || 0}, needs ${data.lpTokenAmount}`);
      return false;
    }

    const stakerAccount = await getAccount(data.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-unstake] Staker account ${data.staker} not found.`);
      return false;
    }
    
    // TODO: Add validation for data.withdrawRewards if reward logic is implemented

    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error validating unstake data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmUnstakeData, sender: string): Promise<boolean> {
  try {
    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.error(`[farm-unstake] CRITICAL: Farm ${data.farmId} not found during processing.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPosition | null;
    if (!userFarmPos || userFarmPos.stakedLpAmount < data.lpTokenAmount) {
      logger.error(`[farm-unstake] CRITICAL: Staker ${data.staker} has insufficient staked LP for farm ${data.farmId} during processing.`);
      return false;
    }

    // 1. Decrease stakedLpAmount in UserFarmPosition
    const newStakedLpAmount = userFarmPos.stakedLpAmount - data.lpTokenAmount;
    const userFarmPosUpdateSuccess = await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { $set: { stakedLpAmount: newStakedLpAmount, lastUnstakedAt: new Date().toISOString() } } // Assuming lastUnstakedAt field
    );

    if (!userFarmPosUpdateSuccess) {
        logger.error(`[farm-unstake] Failed to update user farm position ${userFarmPositionId}. Unstaking aborted.`);
        return false;
    }

    // 2. Decrease totalLpStaked in the Farm document
    const farmUpdateSuccess = await cache.updateOnePromise(
        'farms',
        { _id: data.farmId },
        { $inc: { totalLpStaked: -data.lpTokenAmount }, $set: { lastUpdatedAt: new Date().toISOString() } }
    );

    if (!farmUpdateSuccess) {
        logger.error(`[farm-unstake] CRITICAL: Failed to update totalLpStaked for farm ${data.farmId}. Rolling back user farm position update for ${userFarmPositionId}.`);
        await cache.updateOnePromise('userFarmPositions', { _id: userFarmPositionId }, { $set: { stakedLpAmount: userFarmPos.stakedLpAmount }}); // Rollback
        return false;
    }

    // 3. Increase LP token balance in UserLiquidityPosition
    const poolIdForLp = farm.lpTokenIssuer; // This is the poolId
    const userLpDestinationPositionId = `${data.staker}-${poolIdForLp}`;
    
    // We need to ensure the UserLiquidityPosition exists or create it if the user somehow has no LP in that pool anymore (unlikely if they had LPs to stake)
    const lpReturnSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpDestinationPositionId },
        {
            $inc: { lpTokenBalance: data.lpTokenAmount },
            $setOnInsert: { // This will only apply if we were to use an upsert, which we are not here. Let's adjust.
                provider: data.staker,
                poolId: poolIdForLp,
                createdAt: new Date().toISOString() 
            },
            $set: { lastUpdatedAt: new Date().toISOString() }
        },
        // Corrected: findOne, then update or insert explicitly as updateOnePromise doesn't take upsert here.
        // For now, assuming the UserLiquidityPosition MUST exist if they staked from it.
        // If it might not, we need to fetch it first, then update, or insert if null. This is simpler path:
        // { upsert: true } // This was the old issue with userFarmPositions, cache.updateOnePromise does not take this.
    );
    // Refactoring step 3 based on previous learning for upsert-like behavior
    let finalLpReturnSuccess = false;
    const existingUserLiquidityPos = await cache.findOnePromise('userLiquidityPositions', { _id: userLpDestinationPositionId }) as UserLiquidityPosition | null;
    if (existingUserLiquidityPos) {
        finalLpReturnSuccess = await cache.updateOnePromise(
            'userLiquidityPositions',
            { _id: userLpDestinationPositionId },
            {
                $inc: { lpTokenBalance: data.lpTokenAmount },
                $set: { lastUpdatedAt: new Date().toISOString() }
            }
        );
    } else {
        // This case should be rare: user is unstaking, but their original UserLiquidityPosition for that LP token is gone.
        // For safety, we can recreate it, or log an error. Recreating might be more user-friendly.
        logger.warn(`[farm-unstake] UserLiquidityPosition ${userLpDestinationPositionId} not found. Recreating for returning LP tokens.`);
        const newUserLiquidityPos: UserLiquidityPosition = {
            _id: userLpDestinationPositionId,
            provider: data.staker,
            poolId: poolIdForLp,
            lpTokenBalance: data.lpTokenAmount,
            createdAt: new Date().toISOString(), // Need this field in UserLiquidityPosition
            // lastProvidedAt will not be set here, as this is a return from farm
        };
        finalLpReturnSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('userLiquidityPositions', newUserLiquidityPos, (err, success) => {
                if (err || !success) {
                    logger.error(`[farm-unstake] Failed to insert new user liquidity position ${userLpDestinationPositionId}: ${err || 'insert not successful'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    if (!finalLpReturnSuccess) {
        logger.error(`[farm-unstake] CRITICAL: Failed to return LP tokens to ${userLpDestinationPositionId}. Rolling back farm total and user farm position.`);
        await cache.updateOnePromise('farms', { _id: data.farmId }, { $inc: { totalLpStaked: data.lpTokenAmount }}); // Rollback farm total
        await cache.updateOnePromise('userFarmPositions', { _id: userFarmPositionId }, { $set: { stakedLpAmount: userFarmPos.stakedLpAmount }}); // Rollback user farm pos
        return false;
    }

    // TODO: Handle reward claiming if data.withdrawRewards is true

    logger.info(`[farm-unstake] Staker ${data.staker} unstaked ${data.lpTokenAmount} LP tokens from farm ${data.farmId} to pool ${poolIdForLp}.`);

    const eventDocument = {
      type: 'farmUnstake',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        farmId: data.farmId,
        staker: data.staker,
        lpTokenSymbol: farm.lpTokenSymbol,
        lpTokenIssuer: farm.lpTokenIssuer,
        lpTokenAmount: data.lpTokenAmount
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[farm-unstake] CRITICAL: Failed to log farmUnstake event for ${data.farmId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error processing unstake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 