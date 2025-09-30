import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { FarmClaimRewardsData, FarmData, UserFarmPositionData } from './farm-interfaces.js';

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
        if (currentBlockNum < farmStartBlock || farm.status !== 'active') {
            logger.warn(`[farm-claim-rewards] Farm ${data.farmId} not active or not started at block=${currentBlockNum}.`);
            return false;
        }
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
        if (!userFarmPos) {
            logger.warn(`[farm-claim-rewards] Staker ${sender} has no staking position in farm ${data.farmId}.`);
            return false;
        }
        const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
        if (rewardsPerBlock <= toBigInt(0)) {
            logger.warn(`[farm-claim-rewards] rewardsPerBlock is zero for farm ${data.farmId}.`);
            return false;
        }
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

        const lastHarvestBlock = Number(userFarmPos.lastHarvestBlock ?? farmStartBlock);
        const blocksElapsed = BigInt(Math.max(0, currentBlockNum - lastHarvestBlock));
        const farmRewardsGenerated = rewardsPerBlock * blocksElapsed;
        let pendingRewards = (farmRewardsGenerated * stakedAmount) / totalStaked;

        const rewardToken = await cache.findOnePromise('tokens', { symbol: farm.rewardToken }) as any;
        if (farm.isAuto && rewardToken && rewardToken.maxSupply) {
            const currentSupply = toBigInt(rewardToken.currentSupply || '0');
            const maxSupply = toBigInt(rewardToken.maxSupply);
            const supplyLeft = maxSupply - currentSupply;
            if (pendingRewards > supplyLeft) {
                pendingRewards = supplyLeft;
            }
        }
        else {
            const rewardBalance = toBigInt(farm.rewardBalance || '0');
            if (pendingRewards > rewardBalance) {
                pendingRewards = rewardBalance;
            }
        }

        if (pendingRewards <= toBigInt(0)) {
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
        const lastHarvestBlock = Number(userFarmPos.lastHarvestBlock ?? farmStartBlock);
        const blocksElapsed = BigInt(Math.max(0, currentBlockNum - lastHarvestBlock));
        const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');

        const totalStaked = toBigInt(farm.totalStaked || '0');
        const stakedAmount = toBigInt(userFarmPos.stakedAmount || '0');
        const farmRewardsGenerated = rewardsPerBlock * blocksElapsed;
        let pendingRewards = (farmRewardsGenerated * stakedAmount) / totalStaked;

        const rewardToken = await cache.findOnePromise('tokens', { symbol: farm.rewardToken }) as any;
        const rewardBalance = toBigInt(farm.rewardBalance || '0');
        if (farm.isAuto && rewardToken && rewardToken.maxSupply) {
            const currentSupply = toBigInt(rewardToken.currentSupply || '0');
            const maxSupply = toBigInt(rewardToken.maxSupply);
            const supplyLeft = maxSupply - currentSupply;
            if (pendingRewards > supplyLeft) {
                pendingRewards = supplyLeft;
            }
        }
        else {
            if (pendingRewards > rewardBalance) {
                pendingRewards = rewardBalance;
            }
        }


        logger.debug(`[farm-claim-rewards] Calculated rewards for ${sender}: ${pendingRewards} (blocksElapsed=${blocksElapsed}).`);
        if (!farm.isAuto) {
            await cache.updateOnePromise(
                'farms',
                { _id: data.farmId },
                { $set: { rewardBalance: toDbString(rewardBalance - pendingRewards), lastUpdatedBlock: chain.getLatestBlock().id } }
            );
        }
        else {
            await cache.updateOnePromise('tokens', { symbol: farm.rewardToken }, { $set: { currentSupply: toDbString(toBigInt(rewardToken.currentSupply) + toBigInt(pendingRewards)) } });
        }
        const newPendingRewards = toBigInt(userFarmPos.pendingRewards || '0') + pendingRewards;
        // Credit user
        const creditOk = await adjustUserBalance(sender, farm.rewardToken, toBigInt(newPendingRewards));
        if (!creditOk) {
            logger.error(`[farm-claim-rewards] Failed to credit rewards for ${sender} in ${farm.rewardToken}.`);
            return false;
        }
        await cache.updateOnePromise(
            'userFarmPositions',
            { _id: userFarmPositionId },
            {
                $set: {
                    lastHarvestBlock: currentBlockNum,
                    lastUpdatedAt: new Date().toISOString(),
                    pendingRewards: toDbString(0),
                },
            }
        );

        logger.debug(`[farm-claim-rewards] ${sender} claimed ${pendingRewards} rewards from farm ${data.farmId}.`);

        // Log event
        await logTransactionEvent('farm_rewards_claimed', sender, {
            farmId: data.farmId,
            staker: sender,
            rewardAmount: toDbString(newPendingRewards),
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
