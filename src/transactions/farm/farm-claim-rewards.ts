import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, Farm, UserFarmPosition } from './farm-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js'; // For actual reward transfer later

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
    const rewardsToClaim = 0; // No rewards calculated yet.
    logger.debug(`[farm-claim-rewards] Placeholder: Calculated ${rewardsToClaim} ${farm.rewardTokenSymbol} rewards for ${data.staker} from farm ${data.farmId}.`);

    if (rewardsToClaim > 0) {
      // TODO: Transfer rewardsToClaim of farm.rewardTokenSymbol (from farm.rewardTokenIssuer) 
      // from a designated farm rewards account/escrow to data.staker account.
      // This would involve: 
      // 1. Checking farm's reward pool balance.
      // 2. Calling adjustBalance for the farm's reward pool (debit).
      // 3. Calling adjustBalance for the staker (credit).
      // This needs careful atomicity and error handling.
      logger.debug(`[farm-claim-rewards] Placeholder: Would transfer ${rewardsToClaim} ${farm.rewardTokenSymbol} to ${data.staker}.`);
    }

    // Update lastClaimedAt in UserFarmPosition, even if rewardsToClaim is 0, to mark the claim attempt.
    const userPosUpdateSuccess = await cache.updateOnePromise(
        'userFarmPositions',
        { _id: userFarmPositionId },
        { $set: { lastClaimedAt: new Date().toISOString() } }
    );

    if (!userPosUpdateSuccess) {
        // This is not ideal, as the claim was processed (even if 0 rewards) but not marked.
        // However, if rewards were transferred, this becomes more critical.
        logger.warn(`[farm-claim-rewards] Failed to update lastClaimedAt for ${userFarmPositionId}.`);
        // Depending on rewards transferred, might not want to return false here if rewards WERE sent.
    }

    logger.debug(`[farm-claim-rewards] ${data.staker} claimed rewards from farm ${data.farmId}. Amount: ${rewardsToClaim} ${farm.rewardTokenSymbol}.`);

    const eventDocument = {
      type: 'farmClaimRewards',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        farmId: data.farmId,
        staker: data.staker,
        rewardTokenSymbol: farm.rewardTokenSymbol,
        rewardTokenIssuer: farm.rewardTokenIssuer,
        rewardsClaimed: rewardsToClaim // Will be 0 for now
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[farm-claim-rewards] CRITICAL: Failed to log farmClaimRewards event for ${data.farmId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[farm-claim-rewards] Error processing claim rewards for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 