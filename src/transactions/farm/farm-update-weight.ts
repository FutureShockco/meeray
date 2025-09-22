import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { logEvent } from '../../utils/event-logger.js';

export interface FarmUpdateWeightData {
  farmId: string;
  newWeight: number;
  updatedBy: string;
}

export interface FarmBatchUpdateWeightsData {
  updates: Array<{
    farmId: string;
    weight: number;
  }>;
  updatedBy: string;
}

export async function validateTx(data: FarmUpdateWeightData, sender: string): Promise<boolean> {
  logger.debug(`[farm-update-weight] Validating weight update from ${sender} for farm ${data.farmId}`);

  if (sender !== data.updatedBy) {
    logger.warn('[farm-update-weight] Sender must match updatedBy.');
    return false;
  }

  // Only allow master account or designated admin to update farm weights
  if (sender !== config.masterName) {
    logger.warn(`[farm-update-weight] Only ${config.masterName} can update farm weights.`);
    return false;
  }

  if (!data.farmId || data.newWeight === undefined) {
    logger.warn('[farm-update-weight] Missing required fields: farmId, newWeight.');
    return false;
  }

  if (!validate.integer(data.newWeight, true, false, 1000, 0)) {
    logger.warn(`[farm-update-weight] Invalid weight: ${data.newWeight}. Must be between 0-1000.`);
    return false;
  }

  const farm = await cache.findOnePromise('farms', { _id: data.farmId });
  if (!farm) {
    logger.warn(`[farm-update-weight] Farm ${data.farmId} not found.`);
    return false;
  }

  if (!farm.isNativeFarm) {
    logger.warn(`[farm-update-weight] Farm ${data.farmId} is not a native farm. Weights only apply to native farms.`);
    return false;
  }

  logger.debug('[farm-update-weight] Validation passed.');
  return true;
}

export async function processTx(data: FarmUpdateWeightData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[farm-update-weight] Processing weight update from ${sender} for farm ${data.farmId}`);
  
  try {
    const now = new Date().toISOString();
    
    const result = await cache.updateOnePromise('farms', 
      { _id: data.farmId },
      { 
        $set: { 
          weight: data.newWeight,
          lastUpdatedAt: now
        }
      }
    );

    if (!result) {
      logger.error(`[farm-update-weight] Failed to update farm ${data.farmId} weight.`);
      return false;
    }

    await logEvent('farm', 'weight_updated', sender, {
      farmId: data.farmId,
      oldWeight: 'unknown', // We could fetch this before update if needed
      newWeight: data.newWeight
    });

    logger.debug(`[farm-update-weight] Successfully updated farm ${data.farmId} weight to ${data.newWeight}.`);
    return true;

  } catch (error) {
    logger.error(`[farm-update-weight] Error processing: ${error}`);
    return false;
  }
}

// Batch update function
export async function validateBatchTx(data: FarmBatchUpdateWeightsData, sender: string): Promise<boolean> {
  logger.debug(`[farm-batch-update-weights] Validating batch weight update from ${sender}`);

  if (sender !== data.updatedBy) {
    logger.warn('[farm-batch-update-weights] Sender must match updatedBy.');
    return false;
  }

  if (sender !== config.masterName) {
    logger.warn(`[farm-batch-update-weights] Only ${config.masterName} can update farm weights.`);
    return false;
  }

  if (!Array.isArray(data.updates) || data.updates.length === 0) {
    logger.warn('[farm-batch-update-weights] Missing or empty updates array.');
    return false;
  }

  if (data.updates.length > 50) {
    logger.warn('[farm-batch-update-weights] Too many updates. Maximum 50 allowed per batch.');
    return false;
  }

  // Validate each update
  for (const update of data.updates) {
    if (!update.farmId || update.weight === undefined) {
      logger.warn('[farm-batch-update-weights] Missing farmId or weight in update.');
      return false;
    }

    if (!validate.integer(update.weight, true, false, 1000, 0)) {
      logger.warn(`[farm-batch-update-weights] Invalid weight: ${update.weight}. Must be between 0-1000.`);
      return false;
    }

    const farm = await cache.findOnePromise('farms', { _id: update.farmId });
    if (!farm) {
      logger.warn(`[farm-batch-update-weights] Farm ${update.farmId} not found.`);
      return false;
    }

    if (!farm.isNativeFarm) {
      logger.warn(`[farm-batch-update-weights] Farm ${update.farmId} is not a native farm.`);
      return false;
    }
  }

  logger.debug('[farm-batch-update-weights] Validation passed.');
  return true;
}

export async function processBatch(data: FarmBatchUpdateWeightsData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[farm-batch-update-weights] Processing batch weight update from ${sender}`);
  
  try {
    const now = new Date().toISOString();
    let successCount = 0;

    for (const update of data.updates) {
      const result = await cache.updateOnePromise('farms', 
        { _id: update.farmId },
        { 
          $set: { 
            weight: update.weight,
            lastUpdatedAt: now
          }
        }
      );

      if (result) {
        successCount++;
      } else {
        logger.warn(`[farm-batch-update-weights] Failed to update farm ${update.farmId}`);
      }
    }

    await logEvent('farm', 'batch_weights_updated', sender, {
      totalUpdates: data.updates.length,
      successCount,
      updates: data.updates.map(u => ({ farmId: u.farmId, weight: u.weight }))
    });

    if (successCount === data.updates.length) {
      logger.debug(`[farm-batch-update-weights] Successfully updated all ${successCount} farm weights.`);
      return true;
    } else {
      logger.warn(`[farm-batch-update-weights] Partial success: ${successCount}/${data.updates.length} farms updated.`);
      return false; // Consider partial failure as overall failure
    }

  } catch (error) {
    logger.error(`[farm-batch-update-weights] Error processing: ${error}`);
    return false;
  }
}