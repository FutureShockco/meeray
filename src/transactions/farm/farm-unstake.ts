import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmUnstakeData, FarmData, UserFarmPositionData } from './farm-interfaces.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account.js';
import { convertToBigInt, convertToString, toBigInt } from '../../utils/bigint.js';

const NUMERIC_FIELDS: Array<keyof FarmUnstakeData> = ['lpTokenAmount'];

export async function validateTx(data: FarmUnstakeData, sender: string): Promise<boolean> {
  try {
    const unstakeData = data;

    if (!unstakeData.farmId || !unstakeData.staker || !unstakeData.lpTokenAmount) {
      logger.warn('[farm-unstake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
      return false;
    }

    if (sender !== unstakeData.staker) {
      logger.warn('[farm-unstake] Sender must be the staker.');
      return false;
    }

    if (!validate.string(unstakeData.farmId, 64, 1)) {
      logger.warn('[farm-unstake] Invalid farmId format.');
      return false;
    }

    if (!validate.bigint(unstakeData.lpTokenAmount, false, false, undefined, BigInt(1))) {
      logger.warn('[farm-unstake] lpTokenAmount must be a positive number.');
      return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: unstakeData.farmId }) as FarmData | null;
    if (!farm) {
      logger.warn(`[farm-unstake] Farm ${unstakeData.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${unstakeData.staker}-${unstakeData.farmId}`;
    const userFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
    const userFarmPos = userFarmPosDB;

    if (!userFarmPos || toBigInt(userFarmPos.stakedAmount) < toBigInt(unstakeData.lpTokenAmount)) {
      logger.warn(`[farm-unstake] Staker ${unstakeData.staker} has insufficient staked LP token balance in farm ${unstakeData.farmId}. Has ${userFarmPos?.stakedAmount || 0n}, needs ${unstakeData.lpTokenAmount}`);
      return false;
    }

    const stakerAccount = await getAccount(unstakeData.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-unstake] Staker account ${unstakeData.staker} not found.`);
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error validating unstake data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmUnstakeData, sender: string, id: string): Promise<boolean> {
  try {
    const farm = (await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData)!;
    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = (await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData)!;

    // 1. Decrease staked amount in UserFarmPosition
    const newStakedAmount = toBigInt(userFarmPos.stakedAmount) - toBigInt(data.lpTokenAmount);
    const userFarmPosUpdateSuccess = await cache.updateOnePromise(
      'userFarmPositions',
      { _id: userFarmPositionId },
      { 
        $set: {
          stakedAmount: newStakedAmount.toString(),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    );

    if (!userFarmPosUpdateSuccess) {
      logger.error(`[farm-unstake] Failed to update user farm position ${userFarmPositionId}. Unstaking aborted.`);
      return false;
    }

    // 2. Decrease totalStaked in Farm document
    const farmUpdateSuccess = await cache.updateOnePromise(
      'farms',
      { _id: data.farmId },
      { 
        $inc: { totalStaked: (-toBigInt(data.lpTokenAmount)).toString() },
        $set: { lastUpdatedAt: new Date().toISOString() }
      }
    );

    if (!farmUpdateSuccess) {
      logger.error(`[farm-unstake] CRITICAL: Failed to update farm total staked. Rolling back user farm position update.`);
      await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { 
          $set: { stakedAmount: userFarmPos.stakedAmount }
        }
      );
      return false;
    }

    // 3. Return LP tokens to user's liquidity position
    const poolIdForLp = farm.stakingToken.issuer;
    const userLpDestinationPositionId = `${data.staker}-${poolIdForLp}`;
    let finalLpReturnSuccess = false;

    const existingUserLiquidityPos = await cache.findOnePromise('userLiquidityPositions', { _id: userLpDestinationPositionId }) as UserLiquidityPositionData | null;

    if (existingUserLiquidityPos) {
      finalLpReturnSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpDestinationPositionId },
        {
          $set: {
            lpTokenBalance: (toBigInt(existingUserLiquidityPos.lpTokenBalance) + toBigInt(data.lpTokenAmount)).toString(),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      // Create new position for returning LP tokens
      const newUserLiquidityPos: UserLiquidityPositionData = {
        _id: userLpDestinationPositionId,
        provider: data.staker,
        poolId: poolIdForLp,
        lpTokenBalance: data.lpTokenAmount,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      };

      // Convert BigInt fields to strings for database storage
      const newUserLiquidityPosDB = convertToString(newUserLiquidityPos, ['lpTokenBalance']);

      finalLpReturnSuccess = await new Promise<boolean>((resolve) => {
        cache.insertOne('userLiquidityPositions', newUserLiquidityPosDB, (err, success) => {
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
      logger.error(`[farm-unstake] CRITICAL: Failed to return LP tokens to user position. Rolling back farm total and user farm position.`);
      // Rollback farm total
      await cache.updateOnePromise(
        'farms',
        { _id: data.farmId },
        { $inc: { totalStaked: toBigInt(data.lpTokenAmount).toString() } }
      );
      // Rollback user farm position
      await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { $set: { stakedAmount: userFarmPos.stakedAmount } }
      );
      return false;
    }

    logger.debug(`[farm-unstake] Staker ${data.staker} unstaked ${data.lpTokenAmount} LP tokens from farm ${data.farmId} to pool ${poolIdForLp}.`);


    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error processing unstake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 