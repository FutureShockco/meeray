import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { FarmData, FarmUpdateData, UserFarmPositionData } from './farm-interfaces.js';
import { recalculateNativeFarmRewards } from '../../utils/farm.js';


export async function validateTx(data: FarmUpdateData, sender: string): Promise<boolean> {
    if (!data.farmId) {
        logger.warn('[farm-update] Missing farmId.');
        return false;
    }

    if (data.newWeight === undefined && data.newStatus === undefined) {
        logger.warn('[farm-update] Nothing to update: newWeight or newStatus required.');
        return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: data.farmId });
    if (!farm) {
        logger.warn(`[farm-update] Farm ${data.farmId} not found.`);
        return false;
    }

    if (farm.creator !== sender) {
        logger.warn(`[farm-update] Only the farm creator (${farm.creator}) can update the farm. Sender: ${sender}`);
        return false;
    }

    if (data.newWeight !== undefined) {
        if (!validate.integer(data.newWeight, true, false, 1000, 0)) {
            logger.warn(`[farm-update] Invalid weight: ${data.newWeight}. Must be between 0-1000.`);
            return false;
        }
        if (!farm.isNativeFarm) {
            logger.warn(`[farm-update] Farm ${data.farmId} is not a native farm. Weights only apply to native farms.`);
            return false;
        }
    }

    if (data.newStatus !== undefined) {
        if (!['active', 'paused', 'cancelled'].includes(data.newStatus)) {
            logger.warn(`[farm-update] Invalid status: ${data.newStatus}.`);
            return false;
        }
        if (farm.status === 'cancelled') {
            logger.warn(`[farm-update] Cannot update a cancelled farm ${data.farmId}.`);
            return false;
        }
        if (farm.status === data.newStatus) {
            logger.warn(`[farm-update] Farm ${data.farmId} is already in status ${data.newStatus}.`);
            return false;
        }
        if (data.newStatus === 'active') {
            const currentBlockNum = await chain.getLatestBlock()._id;
            if (currentBlockNum < (farm.startBlock || 0)) {
                logger.warn(`[farm-update] Cannot activate farm ${data.farmId} before its start block ${farm.startBlock}. Current block: ${currentBlockNum}`);
                return false;
            }
        }
    }
    return true;
}

export async function processTx(data: FarmUpdateData, sender: string, _transactionId: string): Promise<boolean> {
    logger.debug(`[farm-update] Processing update from ${sender} for farm ${data.farmId}`);

    try {
        const now = new Date().toISOString();
        const updateFields: any = { lastUpdatedAt: now };

        if (data.newWeight !== undefined) {
            updateFields.weight = data.newWeight;
        }
        if (data.newStatus !== undefined) {
            updateFields.status = data.newStatus;
        }
        if (data.reason !== undefined) {
            updateFields.lastUpdateReason = data.reason;
        }

        // If status or weight is changing, snapshot all users' rewards (to avoid losing pending rewards when rewardsPerBlock changes)
        if (data.newStatus !== undefined || data.newWeight !== undefined) {
            const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData;
            const currentBlockNum = await chain.getLatestBlock()._id;
            const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
            const totalStaked = toBigInt(farm.totalStaked || '0');

            // Cap by maxSupply if isAuto
            let supplyLeft = undefined;
            if (farm.isAuto) {
                const rewardToken = await cache.findOnePromise('tokens', { symbol: farm.rewardToken }) as any;
                if (rewardToken && rewardToken.maxSupply) {
                    const currentSupply = toBigInt(rewardToken.currentSupply || '0');
                    const maxSupply = toBigInt(rewardToken.maxSupply);
                    supplyLeft = maxSupply - currentSupply;
                }
            }

            let totalAdded = 0n;
            const userPositions = await cache.findPromise('userFarmPositions', { farmId: data.farmId }) as UserFarmPositionData[];
            for (const userPos of userPositions) {
                const blocksElapsed = BigInt(Math.max(0, currentBlockNum - Number(userPos.lastHarvestBlock)));
                const stakedAmount = toBigInt(userPos.stakedAmount || '0');
                let pendingRewards = (rewardsPerBlock * blocksElapsed * stakedAmount) / (totalStaked === 0n ? 1n : totalStaked);

                // Cap by supplyLeft if isAuto
                if (supplyLeft !== undefined) {
                    const remaining = supplyLeft - totalAdded;
                    if (pendingRewards > remaining) {
                        pendingRewards = remaining > 0n ? remaining : 0n;
                    }
                    totalAdded += pendingRewards;
                }

                await cache.updateOnePromise(
                    'userFarmPositions',
                    { _id: userPos._id },
                    {
                        $set: {
                            pendingRewards: toDbString(toBigInt(userPos.pendingRewards || '0') + pendingRewards),
                            lastHarvestBlock: currentBlockNum,
                            lastUpdatedAt: now,
                        },
                    }
                );
            }
        }

        const result = await cache.updateOnePromise(
            'farms',
            { _id: data.farmId },
            { $set: updateFields }
        );

        if (!result) {
            logger.error(`[farm-update] Failed to update farm ${data.farmId}.`);
            return false;
        }

        await logEvent('farm', 'updated', sender, {
            farmId: data.farmId,
            newWeight: data.newWeight,
            newStatus: data.newStatus,
            reason: data.reason,
        });

        logger.debug(`[farm-update] Successfully updated farm ${data.farmId}.`);

        // If this farm is a master-created native farm and weight/status changed, recalculate rewardsPerBlock for all master native farms
        const updatedFarm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData;
        if (updatedFarm && updatedFarm.isNativeFarm && updatedFarm.creator === config.masterName && (data.newWeight !== undefined || data.newStatus !== undefined)) {
            try {
                const recalcOk = await recalculateNativeFarmRewards();
                if (!recalcOk) {
                    logger.error('[farm-update] Recalculation of native farm rewards failed after update; aborting transaction to trigger rollback.');
                    return false;
                }
                logger.debug('[farm-update] Recalculated native farm rewards after update.');
            } catch (err) {
                logger.error(`[farm-update] Error recalculating native farm rewards: ${err}; aborting transaction to trigger rollback.`);
                return false;
            }
        }

        return true;
    } catch (error) {
        logger.error(`[farm-update] Error processing: ${error}`);
        return false;
    }
}