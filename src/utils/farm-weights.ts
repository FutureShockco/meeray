import cache from '../cache.js';
import config from '../config.js';
import { FarmData } from '../transactions/farm/farm-interfaces.js';
import { toBigInt, toDbString } from './bigint.js';
import logger from '../logger.js';

export interface FarmWeightInfo {
  farmId: string;
  weight: number;
  totalStaked: bigint;
  rewardShare: number; // Percentage of total farm rewards (0-100)
  rewardPerBlock: bigint; // Actual MRY rewards per block for this farm
}

export interface FarmRewardDistribution {
  totalWeight: number;
  totalNativeFarmReward: bigint; // From config.farmReward
  farms: FarmWeightInfo[];
}

/**
 * Calculate reward distribution across all active native farms based on their weights
 */
export async function calculateFarmRewardDistribution(blockNumber?: number): Promise<FarmRewardDistribution> {
  try {
    const currentConfig = config.read(blockNumber || 0);
    const totalNativeReward = BigInt(currentConfig.farmReward); // 1 MRY per block

    // Get all active native farms
    const activeFarms = await cache.findPromise('farms', {
      status: 'active',
      isNativeFarm: true
    }) as FarmData[] | null;

    if (!activeFarms || activeFarms.length === 0) {
      return {
        totalWeight: 0,
        totalNativeFarmReward: totalNativeReward,
        farms: []
      };
    }

    // Calculate total weight across all active native farms
    let totalWeight = 0;
    const farmInfos: FarmWeightInfo[] = [];

    for (const farm of activeFarms) {
      totalWeight += farm.weight;
      farmInfos.push({
        farmId: farm._id,
        weight: farm.weight,
        totalStaked: toBigInt(farm.totalStaked || '0'),
        rewardShare: 0, // Will calculate below
        rewardPerBlock: BigInt(0) // Will calculate below
      });
    }

    // Calculate reward share and per-block rewards for each farm
    if (totalWeight > 0) {
      for (const farmInfo of farmInfos) {
        farmInfo.rewardShare = (farmInfo.weight / totalWeight) * 100;
        farmInfo.rewardPerBlock = (totalNativeReward * BigInt(Math.floor(farmInfo.weight * 10000))) / BigInt(totalWeight * 10000);
      }
    }

    return {
      totalWeight,
      totalNativeFarmReward: totalNativeReward,
      farms: farmInfos
    };

  } catch (error) {
    logger.error('[farm-weights] Error calculating reward distribution:', error);
    return {
      totalWeight: 0,
      totalNativeFarmReward: BigInt(config.farmReward),
      farms: []
    };
  }
}

/**
 * Get reward distribution for a specific farm
 */
export async function getFarmRewardInfo(farmId: string): Promise<FarmWeightInfo | null> {
  const distribution = await calculateFarmRewardDistribution();
  return distribution.farms.find(f => f.farmId === farmId) || null;
}

/**
 * Update farm weights (admin function)
 */
export async function updateFarmWeight(farmId: string, newWeight: number): Promise<boolean> {
  try {
    if (newWeight < 0 || newWeight > 1000) {
      logger.warn(`[farm-weights] Invalid weight: ${newWeight}. Must be 0-1000.`);
      return false;
    }

    const result = await cache.updateOnePromise('farms', 
      { _id: farmId },
      { $set: { weight: newWeight, lastUpdatedAt: new Date().toISOString() }}
    );

    if (result) {
      logger.info(`[farm-weights] Updated farm ${farmId} weight to ${newWeight}`);
    }

    return !!result;
  } catch (error) {
    logger.error(`[farm-weights] Error updating farm weight:`, error);
    return false;
  }
}

/**
 * Create or update multiple farm weights at once (admin batch update)
 */
export async function batchUpdateFarmWeights(updates: Array<{farmId: string, weight: number}>): Promise<boolean> {
  try {
    let successCount = 0;
    
    for (const update of updates) {
      const success = await updateFarmWeight(update.farmId, update.weight);
      if (success) successCount++;
    }

    logger.info(`[farm-weights] Batch update completed. ${successCount}/${updates.length} farms updated.`);
    return successCount === updates.length;
  } catch (error) {
    logger.error('[farm-weights] Error in batch update:', error);
    return false;
  }
}

/**
 * Get total APR for a farm (includes both native MRY rewards and any custom token rewards)
 */
export async function calculateFarmAPR(
  farmId: string, 
  mryPrice: number = 1, // MRY price in USD
  lpTokenPrice: number = 1 // LP token price in USD
): Promise<{
  nativeAPR: number;    // APR from native MRY rewards
  customAPR?: number;   // APR from custom token rewards (if any)
  totalAPR: number;     // Combined APR
}> {
  try {
    const farm = await cache.findOnePromise('farms', { _id: farmId }) as FarmData | null;
    if (!farm) {
      return { nativeAPR: 0, totalAPR: 0 };
    }

    const rewardInfo = await getFarmRewardInfo(farmId);
    let nativeAPR = 0;

    if (rewardInfo && farm.isNativeFarm && rewardInfo.totalStaked > BigInt(0)) {
      // Calculate native MRY APR
      const yearlyBlocks = 365 * 24 * 60 * 60 / (config.blockTime / 1000); // blocks per year
      const yearlyNativeRewards = Number(rewardInfo.rewardPerBlock) * yearlyBlocks;
      const yearlyRewardValueUSD = yearlyNativeRewards * mryPrice / Math.pow(10, config.nativeTokenPrecision);
      const totalStakedValueUSD = Number(rewardInfo.totalStaked) * lpTokenPrice / Math.pow(10, 18); // Assuming 18 decimals for LP
      
      if (totalStakedValueUSD > 0) {
        nativeAPR = (yearlyRewardValueUSD / totalStakedValueUSD) * 100;
      }
    }

    // For now, just return native APR. Custom token APR calculation would be similar
    return {
      nativeAPR,
      totalAPR: nativeAPR
    };

  } catch (error) {
    logger.error(`[farm-weights] Error calculating APR for farm ${farmId}:`, error);
    return { nativeAPR: 0, totalAPR: 0 };
  }
}
