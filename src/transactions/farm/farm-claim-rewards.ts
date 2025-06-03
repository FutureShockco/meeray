import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, Farm, UserFarmPosition } from './farm-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js'; // For actual reward transfer later
import { toString, convertToString } from '../../utils/bigint-utils.js'; // Import toString and convertToString
import { logTransactionEvent } from '../../utils/event-logger.js';

export async function validateTx(data: FarmClaimRewardsData, sender: string): Promise<boolean> {
  try {
    if (!data.farmId || !data.staker) {
      logger.warn('[farm-claim-rewards] Invalid data: Missing required fields (farmId, staker).');
      return false;
    }
    if (sender !== data.staker) {
      logger.warn('[farm-claim-rewards] Sender must be the staker.');
      return false;
    }
    if (!validate.string(data.farmId, 64, 1)) {
        logger.warn('[farm-claim-rewards] Invalid farmId format.');
        return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPosition | null;
    if (!userFarmPos) { // User must have a position to claim rewards
      logger.warn(`[farm-claim-rewards] Staker ${data.staker} has no staking position in farm ${data.farmId}.`);
      return false;
    }
    // Optionally, check if userFarmPos.stakedLpAmount > 0 if rewards only accrue to current stakers

    const stakerAccount = await getAccount(data.staker);
    if (!stakerAccount) {
      logger.warn(`[farm-claim-rewards] Staker account ${data.staker} not found.`);
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error(`[farm-claim-rewards] Error validating claim rewards data for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmClaimRewardsData, sender: string, id: string): Promise<boolean> {
  try {
    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as Farm | null;
    if (!farm) {
      logger.error(`[farm-claim-rewards] CRITICAL: Farm ${data.farmId} not found during processing.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPosition | null;
    if (!userFarmPos) {
      logger.error(`[farm-claim-rewards] CRITICAL: User staking position ${userFarmPositionId} not found during processing.`);
      return false;
    }

    // This is where we'd calculate pending rewards based on:
    // - farm.rewardRate, farm.rewardState (e.g., accumulatedRewardsPerShare, lastDistributionTime)
    // - userFarmPos.stakedAmount, userFarmPos.lastHarvestTime
    // For simplicity, using hardcoded calculation logic here.

    // Simplified reward calculation (in reality, rewards would depend on time staked, pool share, etc.)
    const timeStaked = Date.now() - new Date(userFarmPos.lastHarvestTime).getTime();
    const rewardRate = BigInt(100); // Example: 100 reward tokens per day
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysStaked = BigInt(Math.floor(timeStaked / msPerDay));
    const pendingRewards = daysStaked * rewardRate;

    if (pendingRewards <= BigInt(0)) {
      logger.warn(`[farm-claim-rewards] No rewards available for ${data.staker} in farm ${data.farmId}. Time staked: ${timeStaked}ms`);
      return true; // Not an error, just no rewards
    }

    logger.debug(`[farm-claim-rewards] Calculated rewards for ${data.staker}: ${pendingRewards} (${daysStaked} days staked).`);

    // Update user's token balance with the claimed rewards
    const rewardTokenId = `${farm.rewardToken.symbol}${farm.rewardToken.issuer ? '@' + farm.rewardToken.issuer : ''}`;
    const balanceUpdateSuccess = await cache.updateOnePromise(
      'accounts',
      { name: data.staker },
      { $inc: { [`balances.${rewardTokenId}`]: toString(pendingRewards) } }
    );

    if (!balanceUpdateSuccess) {
      logger.error(`[farm-claim-rewards] Failed to update balance for ${data.staker} with ${pendingRewards} ${rewardTokenId}.`);
      return false;
    }

    // Update UserFarmPosition to reset harvest time and add to pendingRewards for tracking
    const updateFarmPosSuccess = await cache.updateOnePromise(
      'userFarmPositions',
      { _id: userFarmPositionId },
      { 
        $set: { 
          lastHarvestTime: new Date().toISOString(), 
          lastUpdatedAt: new Date().toISOString() 
        },
        $inc: convertToString({ pendingRewards: pendingRewards }, ['pendingRewards'])
      }
    );

    if (!updateFarmPosSuccess) {
      logger.error(`[farm-claim-rewards] CRITICAL: Failed to update user farm position ${userFarmPositionId} harvest time. Rewards were distributed but tracking may be inconsistent.`);
      // Distributed rewards, but tracking might be wrong. Log for reconciliation.
    }

    logger.debug(`[farm-claim-rewards] ${data.staker} claimed ${pendingRewards} rewards from farm ${data.farmId}.`);

    const eventData = {
      farmId: data.farmId,
      staker: data.staker,
      rewardTokenSymbol: farm.rewardToken.symbol,
      rewardTokenIssuer: farm.rewardToken.issuer,
      rewardAmount: toString(pendingRewards)
    };
    await logTransactionEvent('farmClaimRewards', sender, eventData, id);

    return true;
  } catch (error) {
    logger.error(`[farm-claim-rewards] Error processing reward claim for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 