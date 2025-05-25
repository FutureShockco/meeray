import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, Farm, UserFarmPosition } from './farm-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js'; // For actual reward transfer later
import { toString } from '../../utils/bigint-utils.js'; // Import toString
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

export async function process(data: FarmClaimRewardsData, sender: string): Promise<boolean> {
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
    // - userFarmPos.stakedLpAmount, userFarmPos.rewardDebt (if using MasterChef-like model)
    // - Time elapsed since last claim or last update to farm/user position.
    const rewardsToClaim = BigInt(0); // No rewards calculated yet.
    logger.debug(`[farm-claim-rewards] Placeholder: Calculated ${toString(rewardsToClaim)} ${farm.rewardToken.symbol} rewards for ${data.staker} from farm ${data.farmId}.`);

    if (rewardsToClaim > BigInt(0)) {
      // TODO: Transfer rewardsToClaim of farm.rewardToken.symbol (from farm.rewardTokenIssuer) 
      // from a designated farm rewards account/escrow to data.staker account.
      // This would involve: 
      // 1. Checking farm's reward pool balance.
      // 2. Calling adjustBalance for the farm's reward pool (debit).
      // 3. Calling adjustBalance for the staker (credit).
      // This needs careful atomicity and error handling.
      logger.debug(`[farm-claim-rewards] Placeholder: Would transfer ${toString(rewardsToClaim)} ${farm.rewardToken.symbol} to ${data.staker}.`);
    }

    // Update lastClaimedAt in UserFarmPosition, even if rewardsToClaim is 0, to mark the claim attempt.
    const userPosUpdateSuccess = await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { $set: { lastHarvestTime: new Date().toISOString() } }
    );

    if (!userPosUpdateSuccess) {
        // This is not ideal, as the claim was processed (even if 0 rewards) but not marked.
        // However, if rewards were transferred, this becomes more critical.
        logger.warn(`[farm-claim-rewards] Failed to update lastHarvestTime for ${userFarmPositionId}.`);
        // Depending on rewards transferred, might not want to return false here if rewards WERE sent.
    }

    logger.debug(`[farm-claim-rewards] ${data.staker} claimed rewards from farm ${data.farmId}. Amount: ${toString(rewardsToClaim)} ${farm.rewardToken.symbol}.`);

    const eventData = {
        farmId: data.farmId,
        staker: data.staker,
        rewardTokenSymbol: farm.rewardToken.symbol,
        rewardTokenIssuer: farm.rewardToken.issuer,
        rewardsClaimed: toString(rewardsToClaim)
    };
    // TODO: The original code was missing the transactionId for logTransactionEvent.
    // Assuming it should be passed, but it's not available in this scope. 
    // For now, logging without it. This might need to be addressed.
    await logTransactionEvent('farmClaimRewards', sender, eventData);

    return true;
  } catch (error) {
    logger.error(`[farm-claim-rewards] Error processing claim rewards for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 