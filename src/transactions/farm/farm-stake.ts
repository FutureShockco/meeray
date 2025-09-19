import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmStakeData, FarmData, UserFarmPositionData } from './farm-interfaces.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account.js';
import { toDbString, toBigInt } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';


export async function validateTx(data: FarmStakeData, sender: string): Promise<boolean> {
  try {

    if (!data.farmId || !data.staker || !data.lpTokenAmount) {
      logger.warn('[farm-stake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
      return false;
    }

    if (sender !== data.staker) {
      logger.warn('[farm-stake] Sender must be the staker.');
      return false;
    }

    if (!validate.string(data.farmId, 64, 1)) {
      logger.warn('[farm-stake] Invalid farmId format.');
      return false;
    }

    if (!validate.bigint(data.lpTokenAmount, false, false, BigInt(1))) {
      logger.warn('[farm-stake] lpTokenAmount must be a positive number.');
      return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData;
    if (!farm) {
      logger.warn(`[farm-stake] Farm ${data.farmId} not found.`);
      return false;
    }

    // The farm.stakingToken.issuer is assumed to be the poolId where these LP tokens originate
    const poolIdForLp = farm.stakingToken.issuer;
    const userLpPositionId = `${data.staker}-${poolIdForLp}`;
    const userLiquidityPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPositionData | null;

    // Convert string amounts to BigInt for comparison
    const userLiquidityPos = userLiquidityPosDB;

    if (!userLiquidityPos || toBigInt(userLiquidityPos.lpTokenBalance) < toBigInt(data.lpTokenAmount)) {
      logger.warn(`[farm-stake] Staker ${data.staker} has insufficient LP token balance for pool ${poolIdForLp} (LP tokens for farm ${data.farmId}). Has ${userLiquidityPos?.lpTokenBalance || 0n}, needs ${data.lpTokenAmount}`);
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

export async function process(data: FarmStakeData, sender: string, id: string, ts?: number): Promise<boolean> {
  try {
    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData | null;
    // Validate farm timing and status using tx timestamp if provided
    const nowMs = ts ?? Date.now();
    if (!farm) return false;
    const farmStart = new Date(farm.startTime).getTime();
    const farmEnd = new Date(farm.endTime).getTime();
    if (farm.status !== 'active' || nowMs < farmStart || nowMs > farmEnd) {
      logger.warn(`[farm-stake] Farm ${data.farmId} not active at ts=${nowMs}.`);
      return false;
    }

    // Enforce min/max stake constraints if set (0 means unlimited)
    const minStake = toBigInt((farm as any).minStakeAmount || '0');
    const maxStake = toBigInt((farm as any).maxStakeAmount || '0');
    if (minStake > BigInt(0) && toBigInt(data.lpTokenAmount) < minStake) {
      logger.warn(`[farm-stake] Amount below minStakeAmount for farm ${data.farmId}.`);
      return false;
    }
    const poolIdForLp = farm!.stakingToken.issuer;
    const userLpSourcePositionId = `${data.staker}-${poolIdForLp}`;
    const userLiquidityPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userLpSourcePositionId }) as UserLiquidityPositionData;
    const userLiquidityPos = userLiquidityPosDB;

    if (!userLiquidityPos || userLiquidityPos.lpTokenBalance < data.lpTokenAmount) {
      logger.error(`[farm-stake] CRITICAL: Staker ${data.staker} has insufficient LP balance for ${poolIdForLp} during processing.`);
      return false;
    }

    // 1. Decrease LP token balance from UserLiquidityPosition
    const newLpBalanceInPool = toBigInt(userLiquidityPos.lpTokenBalance) - toBigInt(data.lpTokenAmount);
    await cache.updateOnePromise(
      'userLiquidityPositions',
      { _id: userLpSourcePositionId },
      {
        $set: { lpTokenBalance: toDbString(newLpBalanceInPool) },
        lastUpdatedAt: new Date().toISOString()
      }
    );

    // 2. Increase totalLpStaked in the Farm document
    const currentFarm = await cache.findOnePromise('farms', { _id: data.farmId });
    const currentTotalStaked = toBigInt(currentFarm?.totalStaked || '0');
    const newTotalStaked = currentTotalStaked + toBigInt(data.lpTokenAmount);

    await cache.updateOnePromise(
      'farms',
      { _id: data.farmId },
      {
        $set: {
          totalStaked: toDbString(newTotalStaked),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    );

    // 3. Create or update UserFarmPosition
    const userFarmPositionId = `${data.staker}-${data.farmId}`;

    const existingUserFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
    const existingUserFarmPos = existingUserFarmPosDB;

    if (existingUserFarmPos) {
      // Update existing position
      await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        {
          $set: {
            stakedAmount: toDbString(toBigInt(existingUserFarmPos.stakedAmount) + toBigInt(data.lpTokenAmount)),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      // Create new position
      const newUserFarmPosition: UserFarmPositionData = {
        _id: userFarmPositionId,
        userId: data.staker,
        farmId: data.farmId,
        stakedAmount: toDbString(data.lpTokenAmount),
        pendingRewards: toDbString(0n),
        lastHarvestTime: new Date(nowMs).toISOString(),
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      };

      await new Promise<boolean>((resolve) => {
        cache.insertOne('userFarmPositions', newUserFarmPosition, (err, success) => {
          if (err || !success) {
            logger.error(`[farm-stake] System error: Failed to insert user farm position ${userFarmPositionId}: ${err || 'insert not successful'}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    logger.debug(`[farm-stake] Staker ${data.staker} staked ${data.lpTokenAmount} LP tokens (from pool ${poolIdForLp}) into farm ${data.farmId}.`);

    // Log event
    await logTransactionEvent('farm_stake', data.staker, {
      farmId: data.farmId,
      staker: data.staker,
      lpTokenAmount: toDbString(data.lpTokenAmount),
      poolId: poolIdForLp,
      totalStaked: toDbString(newTotalStaked)
    });

    return true;
  } catch (error) {
    logger.error(`[farm-stake] Error processing stake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 