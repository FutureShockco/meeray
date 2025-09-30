import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, FarmData, UserFarmPositionData } from './farm-interfaces.js';
import { recalculateNativeFarmRewards } from '../../utils/farm.js';

export async function validateTx(data: FarmClaimRewardsData, sender: string): Promise<boolean> {
    try {
        if (!data.farmId) {
            logger.warn('[farm-claim-rewards] Invalid data: Missing required fields (farmId, staker).');
            return false;
        }
        if (!validate.string(data.farmId, 96, 10)) {
            logger.warn('[farm-claim-rewards] Invalid farmId format.');
            return false;
        }
        const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData | null;
        if (!farm) {
            logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not found.`);
            return false;
        }
        const currentBlockNum = chain.getLatestBlock().id;
        const farmStartBlock = Number(farm.startBlock);
        // Allow claiming when farm is 'active' or 'ended' (ended means rewards exhausted but users can still claim pending rewards)
        if (currentBlockNum < farmStartBlock || (farm.status !== 'active' && farm.status !== 'ended')) {
            logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not active/ended or not started at block=${currentBlockNum}.`);
            return false;
        }
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
        if (!userFarmPos) {
            logger.warn(`[farm-claim-rewards] Staker ${sender} has no staking position in farm ${data.farmId}.`);
            return false;
        }
        const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
        const totalStaked = toBigInt(farm.totalStaked || '0');
        const stakedAmount = toBigInt(userFarmPos.stakedAmount || '0');
        if (totalStaked === toBigInt(0) || stakedAmount === toBigInt(0)) {
            logger.warn(`[farm-claim-rewards] No stake or totalStaked zero for farm ${data.farmId}.`);
            return false;
        }
        const token = await cache.findOnePromise('tokens', { symbol: farm.rewardToken });
        if (!token) {
            logger.warn(`[farm-claim-rewards] Reward token ${farm.rewardToken} for farm ${data.farmId} not found.`);
            return false;
        }

        // Compute newly-accrued rewards since lastHarvestBlock and include any already stored pending rewards
        const lastHarvestBlock = Number(userFarmPos.lastHarvestBlock ?? farmStartBlock);
        const blocksElapsed = BigInt(Math.max(0, currentBlockNum - lastHarvestBlock));
        const farmRewardsGenerated = rewardsPerBlock * blocksElapsed;
        const newlyComputed = (farmRewardsGenerated * stakedAmount) / totalStaked;

        const existingPending = toBigInt(userFarmPos.pendingRewards || '0');
        const rewardToken = await cache.findOnePromise('tokens', { symbol: farm.rewardToken }) as any;

        // Determine how much of newlyComputed can actually be claimed, given remaining supply/balance after accounting for existingPending
        let computable = newlyComputed;
        if (farm.isAuto && rewardToken && rewardToken.maxSupply) {
            const currentSupply = toBigInt(rewardToken.currentSupply || '0');
            const maxSupply = toBigInt(rewardToken.maxSupply);
            const supplyLeft = maxSupply - currentSupply;
            if (existingPending + computable > supplyLeft) {
                computable = supplyLeft > existingPending ? (supplyLeft - existingPending) : 0n;
            }
        } else {
            const rewardBalance = toBigInt(farm.rewardBalance || '0');
            if (existingPending + computable > rewardBalance) {
                computable = rewardBalance > existingPending ? (rewardBalance - existingPending) : 0n;
            }
        }

        const totalToClaim = existingPending + computable;
        if (totalToClaim <= 0n) {
            logger.warn(`[farm-claim-rewards] No rewards available for ${sender} in farm ${data.farmId}. Blocks elapsed: ${blocksElapsed}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-claim-rewards] Error validating claim rewards data for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmClaimRewardsData, sender: string, id: string, ts?: number): Promise<boolean> {
    try {
        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData;
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const userFarmPos = (await cache.findOnePromise('userFarmPositions', {
            _id: userFarmPositionId,
        })) as UserFarmPositionData;

        const currentBlockNum = chain.getLatestBlock().id;
        const farmStartBlock = Number(farm.startBlock);

        // Recompute the same values validated earlier so we can apply them safely here
        const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
        const totalStaked = toBigInt(farm.totalStaked || '0');
        const stakedAmount = toBigInt(userFarmPos.stakedAmount || '0');
        const lastHarvestBlock = Number(userFarmPos.lastHarvestBlock ?? farmStartBlock);
        const blocksElapsed = BigInt(Math.max(0, currentBlockNum - lastHarvestBlock));
        const farmRewardsGenerated = rewardsPerBlock * blocksElapsed;
        const newlyComputed = (farmRewardsGenerated * stakedAmount) / (totalStaked === 0n ? 1n : totalStaked);

        const existingPending = toBigInt(userFarmPos.pendingRewards || '0');
        const rewardToken = await cache.findOnePromise('tokens', { symbol: farm.rewardToken }) as any;

        let computable = newlyComputed;
        if (farm.isAuto && rewardToken && rewardToken.maxSupply) {
            const currentSupply = toBigInt(rewardToken.currentSupply || '0');
            const maxSupply = toBigInt(rewardToken.maxSupply);
            const supplyLeft = maxSupply - currentSupply;
            if (existingPending + computable > supplyLeft) {
                computable = supplyLeft > existingPending ? (supplyLeft - existingPending) : 0n;
            }
        } else {
            const rewardBalance = toBigInt(farm.rewardBalance || '0');
            if (existingPending + computable > rewardBalance) {
                computable = rewardBalance > existingPending ? (rewardBalance - existingPending) : 0n;
            }
        }

        const totalToClaim = existingPending + computable;
        logger.debug(`[farm-claim-rewards] Calculated rewards for ${sender}: totalToClaim=${totalToClaim} (existing=${existingPending}, newly=${computable}, blocksElapsed=${blocksElapsed}).`);

        if (!farm.isAuto) {
            const rewardBalance = toBigInt(farm.rewardBalance || '0');
            await cache.updateOnePromise('farms', { _id: data.farmId }, { $set: { rewardBalance: toDbString(rewardBalance - totalToClaim), lastUpdatedBlock: chain.getLatestBlock().id } });
        } else {
            await cache.updateOnePromise('tokens', { symbol: farm.rewardToken }, { $set: { currentSupply: toDbString(toBigInt(rewardToken.currentSupply) + totalToClaim) } });
        }

        // After deducting/minting rewards, check if the farm has exhausted its reward supply and should be ended
        try {
            const updatedFarm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData;
            let remaining = 0n;
            if (updatedFarm) {
                if (updatedFarm.isAuto) {
                    // For auto farms, remaining is determined by token maxSupply - currentSupply
                    const updatedRewardToken = await cache.findOnePromise('tokens', { symbol: updatedFarm.rewardToken }) as any;
                    if (updatedRewardToken && updatedRewardToken.maxSupply) {
                        const currentSupply = toBigInt(updatedRewardToken.currentSupply || '0');
                        const maxSupply = toBigInt(updatedRewardToken.maxSupply);
                        remaining = maxSupply - currentSupply;
                    } else {
                        remaining = Number.MAX_SAFE_INTEGER as unknown as bigint; // no max supply => effectively infinite
                    }
                } else {
                    remaining = toBigInt(updatedFarm.rewardBalance || '0');
                }

                if (remaining <= 0n) {
                    // Mark farm as ended and zero-out rewardsPerBlock
                    await cache.updateOnePromise('farms', { _id: data.farmId }, { $set: { status: 'ended', rewardsPerBlock: toDbString(0), lastUpdatedBlock: chain.getLatestBlock().id } });
                    logger.info(`[farm-claim-rewards] Farm ${data.farmId} has exhausted rewards and was marked as ended.`);

                    // If native/machine-managed farms changed, recalc global distribution (best-effort)
                    try {
                        if (updatedFarm.isNativeFarm && updatedFarm.creator === config.masterName) {
                            const recalcOk = await recalculateNativeFarmRewards();
                            if (!recalcOk) logger.warn('[farm-claim-rewards] Recalculation of native farm rewards failed after farm end.');
                            else logger.debug('[farm-claim-rewards] Recalculated native farm rewards after farm end.');
                        }
                    } catch (err) {
                        logger.error(`[farm-claim-rewards] Error recalculating native farm rewards after farm end: ${err}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`[farm-claim-rewards] Error checking/ending farm ${data.farmId} after claim: ${err}`);
        }
        // Credit user the totalToClaim and clear pending rewards
        const creditOk = await adjustUserBalance(sender, farm.rewardToken, toBigInt(totalToClaim));
        if (!creditOk) {
            logger.error(`[farm-claim-rewards] Failed to credit rewards for ${sender} in ${farm.rewardToken}.`);
            return false;
        }
        await cache.updateOnePromise('userFarmPositions', { _id: userFarmPositionId }, { $set: { lastHarvestBlock: currentBlockNum, lastUpdatedAt: new Date().toISOString(), pendingRewards: toDbString(0) } });

        logger.debug(`[farm-claim-rewards] ${sender} claimed ${totalToClaim} rewards from farm ${data.farmId}.`);

        // Log event
        await logTransactionEvent('farm_rewards_claimed', sender, {
            farmId: data.farmId,
            staker: sender,
            rewardAmount: toDbString(totalToClaim),
            rewardToken: rewardToken.symbol,
            blocksElapsed: blocksElapsed,
            stakedAmount: toDbString(stakedAmount),
        });

        return true;
    } catch (error) {
        logger.error(`[farm-claim-rewards] Error processing reward claim for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}
