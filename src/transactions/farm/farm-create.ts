import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { FarmCreateData, Farm } from './farm-interfaces.js';
import { generateDeterministicId } from '../../utils/id-utils.js';

// Helper function to generate a unique and deterministic farm ID
function generateFarmId(lpTokenSymbol: string, rewardTokenSymbol: string, rewardTokenIssuer: string): string {
  const rewardComponent = `${rewardTokenSymbol}@${rewardTokenIssuer}`;
  return `FARM_${generateDeterministicId(lpTokenSymbol, rewardComponent)}`;
}

export async function validateTx(data: FarmCreateData, sender: string): Promise<boolean> {
  try {
    if (!data.lpTokenSymbol || !data.rewardTokenSymbol || !data.rewardTokenIssuer) {
      logger.warn('[farm-create] Invalid data: Missing required LP token symbol or reward token fields.');
      return false;
    }

    // Validate LP token symbol (can be complex, e.g., LP_TKA_TKB_FEE100)
    if (!validate.string(data.lpTokenSymbol, 60, 3)) {
      logger.warn(`[farm-create] Invalid lpTokenSymbol: ${data.lpTokenSymbol}.`);
      return false;
    }
    if (!validate.string(data.lpTokenIssuer, 100, 3)) {
      logger.warn(`[farm-create] Invalid lpTokenIssuer (expected source ID like Pool ID): ${data.lpTokenIssuer}.`);
      return false;
    }

    // Validate reward token symbol (standard token symbol format)
    if (!validate.string(data.rewardTokenSymbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[farm-create] Invalid rewardTokenSymbol: ${data.rewardTokenSymbol}.`);
      return false;
    }
    // Validate reward token issuer (account name format)
    if (!validate.string(data.rewardTokenIssuer, 16, 3)) {
      logger.warn(`[farm-create] Invalid rewardTokenIssuer: ${data.rewardTokenIssuer}.`);
      return false;
    }

    if (data.lpTokenSymbol === data.rewardTokenSymbol && data.lpTokenIssuer === data.rewardTokenIssuer) {
        logger.warn('[farm-create] LP token and Reward token cannot be the same.');
        return false;
    }

    // Check if the reward token exists
    const rewardTokenExists = await cache.findOnePromise('tokens', { symbol: data.rewardTokenSymbol, issuer: data.rewardTokenIssuer });
    if (!rewardTokenExists) {
      logger.warn(`[farm-create] Reward Token (${data.rewardTokenSymbol}@${data.rewardTokenIssuer}) not found.`);
      return false;
    }
    
    // Note: Validating LP token existence is tricky. 
    // LP tokens are typically minted by liquidity pools. 
    // A full check would involve finding a pool that would mint this LP token.
    // For now, we'll assume the farm creator provides valid LP token details that will exist when staking happens.
    // Alternatively, LP tokens could be pre-registered in the 'tokens' collection if they are treated as first-class tokens.

    // Check for farm uniqueness
    const farmId = generateFarmId(data.lpTokenSymbol, data.rewardTokenSymbol, data.rewardTokenIssuer);
    const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
    if (existingFarm) {
      logger.warn(`[farm-create] Farm with ID ${farmId} already exists for this LP and reward token pair.`);
      return false;
    }

    const creatorAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!creatorAccount) {
      logger.warn(`[farm-create] Creator account ${sender} not found.`);
      return false;
    }

    // TODO: Validate reward parameters if/when they are added (rewardRate, start/end times etc.)
    // TODO: Fee for farm creation?

    return true;
  } catch (error) {
    logger.error(`[farm-create] Error validating farm create data by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: FarmCreateData, sender: string): Promise<boolean> {
  try {
    const farmId = generateFarmId(data.lpTokenSymbol, data.rewardTokenSymbol, data.rewardTokenIssuer);

    const farmDocument: Farm = {
      _id: farmId,
      lpTokenSymbol: data.lpTokenSymbol,
      lpTokenIssuer: data.lpTokenIssuer,
      rewardTokenSymbol: data.rewardTokenSymbol,
      rewardTokenIssuer: data.rewardTokenIssuer,
      totalLpStaked: 0, // Initially no LP tokens are staked
      // rewardState: { /* initial reward state if applicable */ },
      createdAt: new Date().toISOString(),
      // creator: sender, // Optional: store the farm creator
    };

    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('farms', farmDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[farm-create] Failed to insert farm ${farmId} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!createSuccess) {
      return false;
    }
    logger.debug(`[farm-create] Farm ${farmId} for LP token ${data.lpTokenSymbol} rewarding ${data.rewardTokenSymbol} created by ${sender}.`);

    const eventDocument = {
      type: 'farmCreate',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { ...farmDocument }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[farm-create] CRITICAL: Failed to log farmCreate event for ${farmId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[farm-create] Error processing farm creation by ${sender}: ${error}`);
    return false;
  }
} 