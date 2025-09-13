import logger from '../logger.js';
import cache from '../cache.js';

export interface WeightedRewardDistribution {
  farmId: string;
  weight: number;
  farmReward: string; // BigInt as string
  totalWeight: number;
}

export interface GlobalRewardInfo {
  totalRewardPerBlock: string; // 1 MRY per block as BigInt string
  currentBlock: number;
  totalNativeFarmWeight: number;
  activeFarmCount: number;
}

/**
 * Calculate how much reward each native farm should get based on weights
 */
export async function calculateWeightedRewards(currentBlock: number): Promise<WeightedRewardDistribution[]> {
  logger.debug(`[farm-weights] Calculating weighted rewards for block ${currentBlock}`);

  try {
    // Get all active native farms
    const nativeFarms = await cache.findPromise('farms', { 
      isNativeFarm: true,
      isActive: true 
    });

    if (!nativeFarms || nativeFarms.length === 0) {
      logger.debug('[farm-weights] No active native farms found');
      return [];
    }

    // Calculate total weight of all native farms
    let totalWeight = 0;
    for (const farm of nativeFarms) {
      totalWeight += farm.weight || 0;
    }

    if (totalWeight === 0) {
      logger.warn('[farm-weights] Total weight is 0, no rewards to distribute');
      return [];
    }

    // Total reward per block is 1 MRY (1000000000000000000 wei)
    const totalRewardPerBlock = BigInt('1000000000000000000');

    const distributions: WeightedRewardDistribution[] = [];

    // Calculate each farm's share
    for (const farm of nativeFarms) {
      const farmWeight = farm.weight || 0;
      if (farmWeight > 0) {
        // farmReward = (farmWeight / totalWeight) * totalRewardPerBlock
        const farmReward = (totalRewardPerBlock * BigInt(farmWeight)) / BigInt(totalWeight);
        
        distributions.push({
          farmId: farm._id?.toString() || '',
          weight: farmWeight,
          farmReward: farmReward.toString(),
          totalWeight
        });

        logger.debug(`[farm-weights] Farm ${farm._id}: weight=${farmWeight}/${totalWeight}, reward=${farmReward.toString()}`);
      }
    }

    logger.debug(`[farm-weights] Calculated rewards for ${distributions.length} farms with total weight ${totalWeight}`);
    return distributions;

  } catch (error) {
    logger.error(`[farm-weights] Error calculating weighted rewards: ${error}`);
    throw error;
  }
}

/**
 * Get global reward information for farms
 */
export async function getGlobalRewardInfo(currentBlock: number): Promise<GlobalRewardInfo> {
  logger.debug(`[farm-weights] Getting global reward info for block ${currentBlock}`);

  try {
    // Get all active native farms
    const nativeFarms = await cache.findPromise('farms', { 
      isNativeFarm: true,
      isActive: true 
    });

    let totalWeight = 0;
    for (const farm of nativeFarms || []) {
      totalWeight += farm.weight || 0;
    }

    return {
      totalRewardPerBlock: '1000000000000000000', // 1 MRY
      currentBlock,
      totalNativeFarmWeight: totalWeight,
      activeFarmCount: (nativeFarms || []).length
    };

  } catch (error) {
    logger.error(`[farm-weights] Error getting global reward info: ${error}`);
    throw error;
  }
}

/**
 * Update farm's accumulated rewards based on weight distribution
 */
export async function updateFarmRewards(farmId: string, additionalReward: string): Promise<boolean> {
  logger.debug(`[farm-weights] Updating farm ${farmId} rewards by ${additionalReward}`);

  try {
    const farm = await cache.findOnePromise('farms', { _id: farmId });
    if (!farm) {
      logger.warn(`[farm-weights] Farm ${farmId} not found`);
      return false;
    }

    const currentReward = BigInt(farm.totalRewards || '0');
    const newReward = currentReward + BigInt(additionalReward);

    const result = await cache.updateOnePromise('farms', 
      { _id: farmId },
      { 
        $set: { 
          totalRewards: newReward.toString(),
          lastRewardUpdate: new Date().toISOString()
        }
      }
    );

    if (result) {
      logger.debug(`[farm-weights] Updated farm ${farmId} total rewards to ${newReward.toString()}`);
      return true;
    } else {
      logger.error(`[farm-weights] Failed to update farm ${farmId} rewards`);
      return false;
    }

  } catch (error) {
    logger.error(`[farm-weights] Error updating farm rewards: ${error}`);
    return false;
  }
}

/**
 * Process block rewards for all native farms based on weights
 */
export async function processBlockRewards(currentBlock: number): Promise<boolean> {
  logger.debug(`[farm-weights] Processing block rewards for block ${currentBlock}`);

  try {
    const distributions = await calculateWeightedRewards(currentBlock);
    
    if (distributions.length === 0) {
      logger.debug('[farm-weights] No distributions to process');
      return true; // Not an error, just no active farms
    }

    let successCount = 0;
    for (const distribution of distributions) {
      const success = await updateFarmRewards(distribution.farmId, distribution.farmReward);
      if (success) {
        successCount++;
      }
    }

    const allSuccess = successCount === distributions.length;
    if (allSuccess) {
      logger.debug(`[farm-weights] Successfully processed rewards for all ${successCount} farms`);
    } else {
      logger.warn(`[farm-weights] Partial success: ${successCount}/${distributions.length} farms updated`);
    }

    return allSuccess;

  } catch (error) {
    logger.error(`[farm-weights] Error processing block rewards: ${error}`);
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
        projectedDailyReward: '0'
      };
    }

    // Get total weight of all native farms
    const nativeFarms = await cache.findPromise('farms', { 
      isNativeFarm: true,
      isActive: true 
    });

    let totalWeight = 0;
    for (const f of nativeFarms || []) {
      totalWeight += f.weight || 0;
    }

    const farmWeight = farm.weight || 0;
    const rewardShare = totalWeight > 0 ? (farmWeight / totalWeight) * 100 : 0;
    
    // Daily reward = rewardShare * totalDailyReward
    // Assuming 1200 blocks per day (3 second blocks), 1 MRY per block
    const blocksPerDay = 1200;
    const totalDailyReward = BigInt('1000000000000000000') * BigInt(blocksPerDay); // 1200 MRY per day
    const projectedDailyReward = totalWeight > 0 
      ? (totalDailyReward * BigInt(farmWeight)) / BigInt(totalWeight)
      : BigInt(0);

    return {
      farmId,
      weight: farmWeight,
      isNativeFarm: true,
      rewardShare: parseFloat(rewardShare.toFixed(4)),
      projectedDailyReward: projectedDailyReward.toString()
    };

  } catch (error) {
    logger.error(`[farm-weights] Error getting farm weight info: ${error}`);
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
      isActive: true 
    });

    let totalWeight = 0;
    for (const farm of nativeFarms || []) {
      totalWeight += farm.weight || 0;
    }

    // Max allowed total weight could be 10000 (allowing for fine-grained distribution)
    const maxAllowed = 10000;
    const isValid = totalWeight <= maxAllowed;

    logger.debug(`[farm-weights] Total weight: ${totalWeight}/${maxAllowed}, valid: ${isValid}`);

    return {
      isValid,
      totalWeight,
      maxAllowed
    };

  } catch (error) {
    logger.error(`[farm-weights] Error validating total weights: ${error}`);
    throw error;
  }
}
