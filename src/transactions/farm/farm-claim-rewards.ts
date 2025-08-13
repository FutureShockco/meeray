import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, FarmData, UserFarmPositionData } from './farm-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toDbString, convertToString, toBigInt } from '../../utils/bigint.js';
import config from '../../config.js';

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

    const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData | null;
    if (!farm) {
      logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not found.`);
      return false;
    }

    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
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

export async function process(data: FarmClaimRewardsData, sender: string, id: string, ts?: number): Promise<boolean> {
  try {
    const farm = (await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData);
    const userFarmPositionId = `${data.staker}-${data.farmId}`;
    const userFarmPos = (await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData);

    // Use Steem tx timestamp if provided to make replays deterministic
    const nowMs = ts ?? Date.now();
    const fromMs = new Date(userFarmPos.lastHarvestTime).getTime();
    const elapsedMs = Math.max(0, nowMs - fromMs);

    // Guard: Farm active window
    const farmStart = new Date(farm.startTime).getTime();
    const farmEnd = new Date(farm.endTime).getTime();
    if (nowMs < farmStart || nowMs > farmEnd || farm.status !== 'active') {
      logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not active at ts=${nowMs}.`);
      return true;
    }

    // Approximate per-second rewards from per-block using configured block time
    const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
    if (rewardsPerBlock <= BigInt(0)) {
      logger.warn(`[farm-claim-rewards] rewardsPerBlock is zero for farm ${data.farmId}.`);
      return true;
    }

    const blockTimeMs = config.blockTime || 3000;
    // Total rewards generated in elapsed time proportionally to staker share of total staked
    const totalStaked = toBigInt(farm.totalStaked || '0');
    const stakedAmount = toBigInt(userFarmPos.stakedAmount || '0');
    if (totalStaked === BigInt(0) || stakedAmount === BigInt(0)) {
      logger.warn(`[farm-claim-rewards] No stake or totalStaked zero for farm ${data.farmId}.`);
      return true;
    }
    const blocksElapsed = BigInt(Math.floor(elapsedMs / blockTimeMs));
    const farmRewardsGenerated = rewardsPerBlock * blocksElapsed;
    let pendingRewards = (farmRewardsGenerated * stakedAmount) / totalStaked;
    // Cap by rewardsRemaining if present
    const rewardsRemaining = toBigInt((farm as any).rewardsRemaining || farm.totalRewards || '0');
    if (rewardsRemaining > BigInt(0) && pendingRewards > rewardsRemaining) {
      pendingRewards = rewardsRemaining;
    }

    if (pendingRewards <= BigInt(0)) {
      logger.warn(`[farm-claim-rewards] No rewards available for ${data.staker} in farm ${data.farmId}. Elapsed: ${elapsedMs}ms`);
      return true; // Not an error, just no rewards
    }

    logger.debug(`[farm-claim-rewards] Calculated rewards for ${data.staker}: ${pendingRewards} (elapsedMs=${elapsedMs}, blocks=${blocksElapsed}).`);

    // Debit vault and credit user reward symbol (native farms should reward native token as well)
    const rewardSymbol = farm.rewardToken.symbol;
    const vaultAccountName = (farm as any).vaultAccount as string | undefined;
    if (vaultAccountName) {
      const debitVaultOk = await adjustBalance(vaultAccountName, rewardSymbol, -pendingRewards);
      if (!debitVaultOk) {
        logger.error(`[farm-claim-rewards] Failed to debit vault ${vaultAccountName} for ${pendingRewards} ${rewardSymbol}.`);
        return false;
      }
    }
    const creditOk = await adjustBalance(data.staker, rewardSymbol, pendingRewards);
    if (!creditOk) {
      logger.error(`[farm-claim-rewards] Failed to credit rewards for ${data.staker} in ${rewardSymbol}.`);
      return false;
    }

    // Decrement farm rewardsRemaining
    if ((farm as any).rewardsRemaining !== undefined) {
      const updatedRemaining = rewardsRemaining - pendingRewards;
      await cache.updateOnePromise('farms', { _id: data.farmId }, { $set: { rewardsRemaining: toDbString(updatedRemaining), lastUpdatedAt: new Date().toISOString() } });
    }

    // Update UserFarmPosition harvest time and accumulate pendingRewards for history
    const currentUserFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId });
    const currentPendingRewards = toBigInt(currentUserFarmPos?.pendingRewards || '0');
    const newPendingRewards = currentPendingRewards + pendingRewards;
    
    await cache.updateOnePromise(
      'userFarmPositions',
      { _id: userFarmPositionId },
      { 
        $set: { 
          lastHarvestTime: new Date(nowMs).toISOString(), 
          lastUpdatedAt: new Date().toISOString(),
          pendingRewards: toDbString(newPendingRewards)
        }
      }
    );

    logger.debug(`[farm-claim-rewards] ${data.staker} claimed ${pendingRewards} rewards from farm ${data.farmId}.`);


    return true;
  } catch (error) {
    logger.error(`[farm-claim-rewards] Error processing reward claim for farm ${data.farmId} by ${sender}: ${error}`);
    return false;
  }
} 