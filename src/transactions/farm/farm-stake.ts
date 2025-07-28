import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmStakeData, Farm, UserFarmPosition, FarmStakeDataDB, UserFarmPositionDB } from './farm-interfaces.js';
import { UserLiquidityPosition, UserLiquidityPositionDB } from '../pool/pool-interfaces.js';
import { getAccount } from '../../utils/account.js';
import { convertToBigInt, convertToString, toString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS: Array<keyof FarmStakeData> = ['lpTokenAmount'];

export async function validateTx(data: FarmStakeDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for validation
    const stakeData = convertToBigInt<FarmStakeData>(data, NUMERIC_FIELDS);

    if (!stakeData.farmId || !stakeData.staker || !stakeData.lpTokenAmount) {
      logger.warn('[farm-stake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
      return false;
    }

    if (sender !== stakeData.staker) {
      logger.warn('[farm-stake] Sender must be the staker.');
      return false;
    }

    if (!validate.string(stakeData.farmId, 64, 1)) {
      logger.warn('[farm-stake] Invalid farmId format.');
      return false;
    }

    if (!validate.bigint(stakeData.lpTokenAmount, false, false, undefined, BigInt(1))) {
      logger.warn('[farm-stake] lpTokenAmount must be a positive number.');
      return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: stakeData.farmId }) as Farm | null;
    if (!farm) {
      logger.warn(`[farm-stake] Farm ${stakeData.farmId} not found.`);
      return false;
    }

    // The farm.lpTokenIssuer is assumed to be the poolId where these LP tokens originate
    const poolIdForLp = farm.stakingToken.issuer;
    const userLpPositionId = `${stakeData.staker}-${poolIdForLp}`;
    const userLiquidityPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPositionDB | null;
    
    // Convert string amounts to BigInt for comparison
    const userLiquidityPos = userLiquidityPosDB ? convertToBigInt<UserLiquidityPosition>(userLiquidityPosDB, ['lpTokenBalance']) : null;

    if (!userLiquidityPos || userLiquidityPos.lpTokenBalance < stakeData.lpTokenAmount) {
      logger.warn(`[farm-stake] Staker ${stakeData.staker} has insufficient LP token balance for pool ${poolIdForLp} (LP tokens for farm ${stakeData.farmId}). Has ${userLiquidityPos?.lpTokenBalance || 0n}, needs ${stakeData.lpTokenAmount}`);
      return false;
    }

    const stakerAccount = await getAccount(stakeData.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-stake] Staker account ${stakeData.staker} not found.`);
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error(`[farm-stake] Error validating stake data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmStakeDataDB, sender: string, id: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for processing
    const stakeData = convertToBigInt<FarmStakeData>(data, NUMERIC_FIELDS);

    const farm = await cache.findOnePromise('farms', { _id: stakeData.farmId }) as Farm | null;
    if (!farm) {
      logger.error(`[farm-stake] CRITICAL: Farm ${stakeData.farmId} not found during processing.`);
      return false;
    }

    const poolIdForLp = farm.stakingToken.issuer;
    const userLpSourcePositionId = `${stakeData.staker}-${poolIdForLp}`;
    const userLiquidityPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userLpSourcePositionId }) as UserLiquidityPositionDB | null;
    
    // Convert string amounts to BigInt for comparison
    const userLiquidityPos = userLiquidityPosDB ? convertToBigInt<UserLiquidityPosition>(userLiquidityPosDB, ['lpTokenBalance']) : null;

    if (!userLiquidityPos || userLiquidityPos.lpTokenBalance < stakeData.lpTokenAmount) {
      logger.error(`[farm-stake] CRITICAL: Staker ${stakeData.staker} has insufficient LP balance for ${poolIdForLp} during processing.`);
      return false;
    }

    // 1. Decrease LP token balance from UserLiquidityPosition
    const newLpBalanceInPool = userLiquidityPos.lpTokenBalance - stakeData.lpTokenAmount;
    const lpBalanceUpdateSuccess = await cache.updateOnePromise(
      'userLiquidityPositions',
      { _id: userLpSourcePositionId },
      { 
        $set: convertToString({ lpTokenBalance: newLpBalanceInPool }, ['lpTokenBalance']),
        lastUpdatedAt: new Date().toISOString()
      }
    );

    if (!lpBalanceUpdateSuccess) {
      logger.error(`[farm-stake] Failed to update LP token balance for ${userLpSourcePositionId}. Staking aborted.`);
      return false;
    }

    // 2. Increase totalLpStaked in the Farm document
    const farmUpdateSuccess = await cache.updateOnePromise(
      'farms',
      { _id: stakeData.farmId },
      { 
        $inc: convertToString({ totalStaked: stakeData.lpTokenAmount }, ['totalStaked']),
        $set: { lastUpdatedAt: new Date().toISOString() }
      }
    );

    if (!farmUpdateSuccess) {
      logger.error(`[farm-stake] CRITICAL: Failed to update totalStaked for farm ${stakeData.farmId}. Rolling back LP balance deduction for ${userLpSourcePositionId}.`);
      await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpSourcePositionId },
        { $set: convertToString({ lpTokenBalance: userLiquidityPos.lpTokenBalance }, ['lpTokenBalance']) }
      );
      return false;
    }

    // 3. Create or update UserFarmPosition
    const userFarmPositionId = `${stakeData.staker}-${stakeData.farmId}`;
    let userFarmPosUpdateSuccess = false;

    const existingUserFarmPosDB = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionDB | null;
    const existingUserFarmPos = existingUserFarmPosDB ? convertToBigInt<UserFarmPosition>(existingUserFarmPosDB, ['stakedAmount', 'pendingRewards']) : null;

    if (existingUserFarmPos) {
      // Update existing position
      userFarmPosUpdateSuccess = await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        {
          $set: {
            ...convertToString(
              { stakedAmount: existingUserFarmPos.stakedAmount + stakeData.lpTokenAmount },
              ['stakedAmount']
            ),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      // Create new position
      const newUserFarmPosition: UserFarmPosition = {
        _id: userFarmPositionId,
        userId: stakeData.staker,
        farmId: stakeData.farmId,
        stakedAmount: stakeData.lpTokenAmount,
        pendingRewards: BigInt(0),
        lastHarvestTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      };

      // Convert BigInt fields to strings for database storage with proper padding
      const newUserFarmPositionDB = convertToString(newUserFarmPosition, ['stakedAmount', 'pendingRewards']);

      userFarmPosUpdateSuccess = await new Promise<boolean>((resolve) => {
        cache.insertOne('userFarmPositions', newUserFarmPositionDB, (err, success) => {
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
      await cache.updateOnePromise(
        'farms',
        { _id: stakeData.farmId },
        { $inc: convertToString({ totalStaked: -stakeData.lpTokenAmount }, ['totalStaked']) }
      );
      // Rollback LP balance deduction
      await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpSourcePositionId },
        { $set: convertToString({ lpTokenBalance: userLiquidityPos.lpTokenBalance }, ['lpTokenBalance']) }
      );
      return false;
    }

    logger.debug(`[farm-stake] Staker ${stakeData.staker} staked ${stakeData.lpTokenAmount} LP tokens (from pool ${poolIdForLp}) into farm ${stakeData.farmId}.`);

    const eventData = {
      farmId: stakeData.farmId,
      staker: stakeData.staker,
      lpTokenSymbol: farm.stakingToken.symbol,
      lpTokenIssuer: farm.stakingToken.issuer,
      lpTokenAmount: toString(stakeData.lpTokenAmount) // Convert BigInt to string for logging
    };
    await logTransactionEvent('farmStake', sender, eventData, id);

    return true;
  } catch (error) {
    logger.error(`[farm-stake] Error processing stake for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 