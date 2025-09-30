import cache from '../cache.js';
import logger from '../logger.js';
import { toBigInt, toDbString } from './bigint.js';
import config from '../config.js';

export interface WeightedRewardDistribution {
    farmId: string;
    weight: number;
    farmReward: string; // BigInt as string
    totalWeight: number;
}

export interface GlobalRewardInfo {
    totalRewardPerBlock: string; // native reward per block as string
    currentBlock: number;
    totalNativeFarmWeight: number;
    activeFarmCount: number;
}

/**
 * Generates a deterministic farm ID from two token symbols
 */
export function generateFarmId(tokenA_symbol: string, tokenB_symbol: string): string {
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `farm_${token1}_${token2}`;
}

/**
 * Calculate how much reward each native farm should get based on weights
 * Only counts native farms created by config.masterName and with status 'active'.
 */
export async function calculateWeightedRewards(): Promise<WeightedRewardDistribution[]> {
    logger.debug('[farm-weights] Calculating weighted rewards');
    try {
        const nativeFarms = await cache.findPromise('farms', {
            isNativeFarm: true,
            status: 'active',
            creator: config.masterName,
        });

        if (!nativeFarms || nativeFarms.length === 0) {
            logger.debug('[farm-weights] No active native farms found');
            return [];
        }

        let totalWeight = 0;
        for (const farm of nativeFarms) totalWeight += farm.weight || 0;

        if (totalWeight === 0) {
            logger.warn('[farm-weights] Total weight is 0, no rewards to distribute');
            return [];
        }

        const totalRewardPerBlock = toBigInt((config as any).nativeFarmsReward);

        const distributions: WeightedRewardDistribution[] = [];
        for (const farm of nativeFarms) {
            const farmWeight = farm.weight || 0;
            if (farmWeight <= 0) continue;
            const farmReward = (totalRewardPerBlock * toBigInt(farmWeight)) / toBigInt(totalWeight);
            distributions.push({
                farmId: farm._id?.toString() || '',
                weight: farmWeight,
                farmReward: farmReward.toString(),
                totalWeight,
            });
        }

        logger.debug(`[farm-weights] Calculated rewards for ${distributions.length} farms with total weight ${totalWeight}`);
        return distributions;
    } catch (err) {
        logger.error(`[farm-weights] Error calculating weighted rewards: ${err}`);
        throw err;
    }
}

/**
 * Get global reward information for farms (master-created native farms only)
 */
export async function getGlobalRewardInfo(currentBlock: number): Promise<GlobalRewardInfo> {
    logger.debug(`[farm-weights] Getting global reward info for block ${currentBlock}`);
    try {
        const nativeFarms = await cache.findPromise('farms', {
            isNativeFarm: true,
            status: 'active',
            creator: config.masterName,
        });

        let totalWeight = 0;
        for (const farm of nativeFarms || []) totalWeight += farm.weight || 0;

        return {
            totalRewardPerBlock: (config as any).nativeFarmsReward,
            currentBlock,
            totalNativeFarmWeight: totalWeight,
            activeFarmCount: (nativeFarms || []).length,
        };
    } catch (err) {
        logger.error(`[farm-weights] Error getting global reward info: ${err}`);
        throw err;
    }
}

/**
 * Update farm's accumulated totalRewards by adding additionalReward (string bigint)
 */
export async function updateFarmRewards(farmId: string, additionalReward: string): Promise<boolean> {
    logger.debug(`[farm-weights] Updating farm ${farmId} rewards by ${additionalReward}`);
    try {
        const farm = await cache.findOnePromise('farms', { _id: farmId });
        if (!farm) {
            logger.warn(`[farm-weights] Farm ${farmId} not found`);
            return false;
        }

        const currentReward = toBigInt(farm.totalRewards || '0');
        const newReward = currentReward + toBigInt(additionalReward);

        const result = await cache.updateOnePromise('farms', { _id: farmId }, { $set: { totalRewards: toDbString(newReward), lastRewardUpdate: new Date().toISOString() } });

        if (result) {
            logger.debug(`[farm-weights] Updated farm ${farmId} total rewards to ${newReward.toString()}`);
            return true;
        }
        logger.error(`[farm-weights] Failed to update farm ${farmId} rewards`);
        return false;
    } catch (err) {
        logger.error(`[farm-weights] Error updating farm rewards: ${err}`);
        return false;
    }
}

/**
 * Recalculate native farms' rewardsPerBlock based on config.nativeFarmsReward and each farm's weight.
 * Only updates farms that are native, active and created by config.masterName.
 * Call this whenever a master-created native farm is added or its weight/status changes.
 */
export async function recalculateNativeFarmRewards(): Promise<boolean> {
    logger.debug('[farm-weights] Recalculating native farm rewards');
    try {
        const nativeFarms = await cache.findPromise('farms', {
            isNativeFarm: true,
            status: 'active',
            creator: config.masterName,
        });

        if (!nativeFarms || nativeFarms.length === 0) {
            logger.debug('[farm-weights] No master-created native farms to recalc');
            return true;
        }

        let totalWeight = 0;
        for (const f of nativeFarms) totalWeight += f.weight || 0;
        if (totalWeight === 0) {
            logger.warn('[farm-weights] Total master native farm weight is zero; skipping recalc');
            return false;
        }

        const totalRewardPerBlock = toBigInt((config as any).nativeFarmsReward);

        let successCount = 0;
        for (const f of nativeFarms) {
            const farmWeight = f.weight || 0;
            const farmReward = (totalRewardPerBlock * toBigInt(farmWeight)) / toBigInt(totalWeight);
            const res = await cache.updateOnePromise('farms', { _id: f._id }, { $set: { rewardsPerBlock: toDbString(farmReward) } });
            if (res) successCount++;
        }

        logger.debug(`[farm-weights] Recalculated rewards for ${successCount}/${nativeFarms.length} farms`);
        return successCount === nativeFarms.length;
    } catch (err) {
        logger.error(`[farm-weights] Error recalculating native farm rewards: ${err}`);
        return false;
    }
}

/**
 * Get a farm's current weight and projected rewards
 */
export async function getFarmWeightInfo(farmId: string): Promise<{
    farmId: string;
    weight: number;
    isNativeFarm: boolean;
    rewardShare: number; // Percentage (0-100)
    projectedDailyReward: string; // BigInt as string
} | null> {
    logger.debug(`[farm-weights] Getting weight info for farm ${farmId}`);

    try {
        const farm = await cache.findOnePromise('farms', { _id: farmId });
        if (!farm) {
            logger.warn(`[farm-weights] Farm ${farmId} not found`);
            return null;
        }

        if (!farm.isNativeFarm) {
            return {
                farmId,
                weight: 0,
                isNativeFarm: false,
                rewardShare: 0,
                projectedDailyReward: '0',
            };
        }

        const nativeFarms = await cache.findPromise('farms', {
            isNativeFarm: true,
            status: 'active',
            creator: config.masterName,
        });

        let totalWeight = 0;
        for (const f of nativeFarms || []) totalWeight += f.weight || 0;

        const farmWeight = farm.weight || 0;
        const rewardShare = totalWeight > 0 ? (farmWeight / totalWeight) * 100 : 0;

        // Compute blocks per day from config.blockTime (ms per block)
        const blocksPerDay = Math.floor(86400000 / (config.blockTime || 3000));
        const totalDailyReward = toBigInt((config as any).nativeFarmsReward) * toBigInt(blocksPerDay);
        const projectedDailyReward = totalWeight > 0 ? (totalDailyReward * toBigInt(farmWeight)) / toBigInt(totalWeight) : toBigInt(0);

        return {
            farmId,
            weight: farmWeight,
            isNativeFarm: true,
            rewardShare: parseFloat(rewardShare.toFixed(4)),
            projectedDailyReward: projectedDailyReward.toString(),
        };
    } catch (err) {
        logger.error(`[farm-weights] Error getting farm weight info: ${err}`);
        return null;
    }
}

/**
 * Validate that total weights don't exceed reasonable limits
 */
export async function validateTotalWeights(): Promise<{ isValid: boolean; totalWeight: number; maxAllowed: number }> {
    logger.debug('[farm-weights] Validating total weights');

    try {
        const nativeFarms = await cache.findPromise('farms', {
            isNativeFarm: true,
            status: 'active',
            creator: config.masterName,
        });

        let totalWeight = 0;
        for (const farm of nativeFarms || []) totalWeight += farm.weight || 0;

        const maxAllowed = 10000;
        const isValid = totalWeight <= maxAllowed;

        logger.debug(`[farm-weights] Total weight: ${totalWeight}/${maxAllowed}, valid: ${isValid}`);

        return {
            isValid,
            totalWeight,
            maxAllowed,
        };
    } catch (err) {
        logger.error(`[farm-weights] Error validating total weights: ${err}`);
        throw err;
    }
}
