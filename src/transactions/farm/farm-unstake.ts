import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmUnstakeData, FarmData, UserFarmPositionData } from './farm-interfaces.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

export async function validateTx(data: FarmUnstakeData, sender: string): Promise<boolean> {
  try {

    if (!data.farmId || !data.staker || !data.lpTokenAmount) {
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

    if (!validate.bigint(data.lpTokenAmount, false, false, BigInt(1))) {
      logger.warn('[farm-unstake] lpTokenAmount must be a positive number.');
      return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData | null;
    if (!farm) {
      logger.warn(`[farm-unstake] Farm ${data.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}_${data.farmId}`;
    const userFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
    const userFarmPos = userFarmPosDB;

    if (!userFarmPos || toBigInt(userFarmPos.stakedAmount) < toBigInt(data.lpTokenAmount)) {
      logger.warn(`[farm-unstake] Staker ${data.staker} has insufficient staked LP token balance in farm ${data.farmId}. Has ${userFarmPos?.stakedAmount || 0n}, needs ${data.lpTokenAmount}`);
      return false;
    }

    const stakerAccount = await getAccount(data.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-unstake] Staker account ${data.staker} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error validating unstake data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function processTx(data: FarmUnstakeData, sender: string, id: string, ts?: number): Promise<boolean> {
  try {
    const farm = (await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData);
    const nowMs = ts ?? Date.now();
    const farmStart = new Date(farm.startTime).getTime();
    const farmEnd = new Date(farm.endTime).getTime();
    if (farm.status !== 'active' || nowMs < farmStart || nowMs > farmEnd) {
      logger.warn(`[farm-unstake] Farm ${data.farmId} not active at ts=${nowMs}.`);
      return false;
    }

    // Optional: prevent unstake below minStake if desired for residuals. Not enforcing here.
    const userFarmPositionId = `${data.staker}_${data.farmId}`;
    const userFarmPos = (await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData);

    // 1. Decrease staked amount in UserFarmPosition
    const newStakedAmount = toBigInt(userFarmPos.stakedAmount) - toBigInt(data.lpTokenAmount);
    await cache.updateOnePromise(
      'userFarmPositions',
      { _id: userFarmPositionId },
      {
        $set: {
          stakedAmount: toDbString(newStakedAmount),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    );

    // 2. Decrease totalStaked in Farm document
    const currentFarm = await cache.findOnePromise('farms', { _id: data.farmId });
    const currentTotalStaked = toBigInt(currentFarm?.totalStaked || '0');
    const newTotalStaked = currentTotalStaked - toBigInt(data.lpTokenAmount);

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

    // 3. Return LP tokens to user's liquidity position
    const poolIdForLp = farm.stakingToken.issuer;
    const userLpDestinationPositionId = `${data.staker}_${poolIdForLp}`;

    const existingUserLiquidityPos = await cache.findOnePromise('userLiquidityPositions', { _id: userLpDestinationPositionId }) as UserLiquidityPositionData | null;

    if (existingUserLiquidityPos) {
      await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpDestinationPositionId },
        {
          $set: {
            lpTokenBalance: toDbString(toBigInt(existingUserLiquidityPos.lpTokenBalance) + toBigInt(data.lpTokenAmount)),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      // Create new position for returning LP tokens
      const newUserLiquidityPos: UserLiquidityPositionData = {
        _id: userLpDestinationPositionId,
        user: data.staker,
        poolId: poolIdForLp,
        lpTokenBalance: toDbString(data.lpTokenAmount),
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      };

      await new Promise<boolean>((resolve) => {
        cache.insertOne('userLiquidityPositions', newUserLiquidityPos, (err, success) => {
          if (err || !success) {
            logger.error(`[farm-unstake] System error: Failed to insert new user liquidity position ${userLpDestinationPositionId}: ${err || 'insert not successful'}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    logger.debug(`[farm-unstake] Staker ${data.staker} unstaked ${data.lpTokenAmount} LP tokens from farm ${data.farmId} to pool ${poolIdForLp}.`);

    // Log event
    await logTransactionEvent('farm_unstake', data.staker, {
      farmId: data.farmId,
      staker: data.staker,
      lpTokenAmount: toDbString(data.lpTokenAmount),
      poolId: poolIdForLp,
      totalStaked: toDbString(newTotalStaked)
    });

    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error processing unstake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}