import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmUnstakeData, Farm, UserFarmPosition, FarmUnstakeDataDB, UserFarmPositionDB } from './farm-interfaces.js';
import { UserLiquidityPosition, UserLiquidityPositionDB } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account-utils.js';
import { convertToBigInt, convertToString, toString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS: Array<keyof FarmUnstakeData> = ['lpTokenAmount'];

export async function validateTx(data: FarmUnstakeDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for validation
    const unstakeData = convertToBigInt<FarmUnstakeData>(data, NUMERIC_FIELDS);

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

    const farm = await cache.findOnePromise('farms', { _id: unstakeData.farmId }) as Farm | null;
    if (!farm) {
      logger.warn(`[farm-unstake] Farm ${unstakeData.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${unstakeData.staker}-${unstakeData.farmId}`;
    const userFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionDB | null;
    const userFarmPos = userFarmPosDB ? convertToBigInt<UserFarmPosition>(userFarmPosDB, ['stakedAmount', 'pendingRewards']) : null;

    if (!userFarmPos || userFarmPos.stakedAmount < unstakeData.lpTokenAmount) {
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

export async function process(data: FarmUnstakeDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for processing
    const unstakeData = convertToBigInt<FarmUnstakeData>(data, NUMERIC_FIELDS);

    const farm = await cache.findOnePromise('farms', { _id: unstakeData.farmId }) as Farm | null;
    if (!farm) {
      logger.error(`[farm-unstake] CRITICAL: Farm ${unstakeData.farmId} not found during processing.`);
      return false;
    }

    const userFarmPositionId = `${unstakeData.staker}-${unstakeData.farmId}`;
    const userFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionDB | null;
    const userFarmPos = userFarmPosDB ? convertToBigInt<UserFarmPosition>(userFarmPosDB, ['stakedAmount', 'pendingRewards']) : null;

    if (!userFarmPos || userFarmPos.stakedAmount < unstakeData.lpTokenAmount) {
      logger.error(`[farm-unstake] CRITICAL: Staker ${unstakeData.staker} has insufficient staked LP for farm ${unstakeData.farmId} during processing.`);
      return false;
    }

    // 1. Decrease staked amount in UserFarmPosition
    const newStakedAmount = userFarmPos.stakedAmount - unstakeData.lpTokenAmount;
    const userFarmPosUpdateSuccess = await cache.updateOnePromise(
      'userFarmPositions',
      { _id: userFarmPositionId },
      { 
        $set: {
          ...convertToString({ stakedAmount: newStakedAmount }, ['stakedAmount']),
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
      { _id: unstakeData.farmId },
      { 
        $inc: convertToString({ totalStaked: -unstakeData.lpTokenAmount }, ['totalStaked']),
        $set: { lastUpdatedAt: new Date().toISOString() }
      }
    );

    if (!farmUpdateSuccess) {
      logger.error(`[farm-unstake] CRITICAL: Failed to update farm total staked. Rolling back user farm position update.`);
      await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { 
          $set: convertToString({ stakedAmount: userFarmPos.stakedAmount }, ['stakedAmount'])
        }
      );
      return false;
    }

    // 3. Return LP tokens to user's liquidity position
    const poolIdForLp = farm.stakingToken.issuer;
    const userLpDestinationPositionId = `${unstakeData.staker}-${poolIdForLp}`;
    let finalLpReturnSuccess = false;

    const existingUserLiquidityPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userLpDestinationPositionId }) as UserLiquidityPositionDB | null;
    const existingUserLiquidityPos = existingUserLiquidityPosDB ? convertToBigInt<UserLiquidityPosition>(existingUserLiquidityPosDB, ['lpTokenBalance']) : null;

    if (existingUserLiquidityPos) {
      finalLpReturnSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpDestinationPositionId },
        {
          $set: {
            ...convertToString(
              { lpTokenBalance: existingUserLiquidityPos.lpTokenBalance + unstakeData.lpTokenAmount },
              ['lpTokenBalance']
            ),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      // Create new position for returning LP tokens
      const newUserLiquidityPos: UserLiquidityPosition = {
        _id: userLpDestinationPositionId,
        provider: unstakeData.staker,
        poolId: poolIdForLp,
        lpTokenBalance: unstakeData.lpTokenAmount,
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
        { _id: unstakeData.farmId },
        { $inc: convertToString({ totalStaked: unstakeData.lpTokenAmount }, ['totalStaked']) }
      );
      // Rollback user farm position
      await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { $set: convertToString({ stakedAmount: userFarmPos.stakedAmount }, ['stakedAmount']) }
      );
      return false;
    }

    logger.debug(`[farm-unstake] Staker ${unstakeData.staker} unstaked ${unstakeData.lpTokenAmount} LP tokens from farm ${unstakeData.farmId} to pool ${poolIdForLp}.`);

    const eventData = {
        farmId: unstakeData.farmId,
        staker: unstakeData.staker,
        lpTokenSymbol: farm.stakingToken.symbol,
        lpTokenIssuer: farm.stakingToken.issuer,
        lpTokenAmount: toString(unstakeData.lpTokenAmount)
    };
    await logTransactionEvent('farmUnstake', sender, eventData);

    return true;
  } catch (error) {
    logger.error(`[farm-unstake] Error processing unstake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 