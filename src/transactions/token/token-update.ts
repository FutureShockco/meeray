import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { TokenUpdateData } from './token-interfaces.js'; // Import from new interfaces file

export async function validateTx(data: TokenUpdateData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol) {
      logger.warn('[token-update] Invalid data: Missing required field (symbol).');
      return false;
    }

    // Check if at least one updatable field is provided
    if (data.name === undefined && data.description === undefined && data.logoUrl === undefined && data.websiteUrl === undefined) {
        logger.warn('[token-update] No updatable fields provided (name, description, logoUrl, websiteUrl).');
        return false;
    }

    if (!validate.string(data.symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[token-update] Invalid token symbol format for lookup: ${data.symbol}.`);
      return false;
    }

    if (data.name !== undefined) {
      if (!validate.string(data.name, 50, 1)) {
        logger.warn('[token-update] Invalid new name length (must be 1-50 characters).');
        return false;
      }
    }

    if (data.description !== undefined) {
      // Assuming description can be longer, e.g., max 1000 characters. Min 1 if not empty string.
      if (!validate.string(data.description, 1000, 0)) { 
        logger.warn('[token-update] Invalid new description length (must be 0-1000 characters).');
        return false;
      }
    }

    if (data.logoUrl !== undefined) {
      // Basic URL format check (very simplified). Consider a more robust URL validator.
      if (!validate.string(data.logoUrl, 2048, 10) || !data.logoUrl.startsWith('http')) { 
        logger.warn('[token-update] Invalid new logoUrl format or length.');
        return false;
      }
    }

    if (data.websiteUrl !== undefined) {
      if (!validate.string(data.websiteUrl, 2048, 10) || !data.websiteUrl.startsWith('http')) {
        logger.warn('[token-update] Invalid new websiteUrl format or length.');
        return false;
      }
    }

    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.warn(`[token-update] Token ${data.symbol} not found.`);
      return false;
    }

    if (token.creator !== sender) {
      logger.warn(`[token-update] Sender ${sender} is not the creator of token ${data.symbol}. Only creator can update.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-update] Error validating token update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: TokenUpdateData, sender: string): Promise<boolean> {
  try {
    const fieldsToUpdate: Partial<Pick<TokenUpdateData, 'name' | 'description' | 'logoUrl' | 'websiteUrl'>> & { lastUpdatedAt?: string } = {};
    
    if (data.name !== undefined) fieldsToUpdate.name = data.name;
    if (data.description !== undefined) fieldsToUpdate.description = data.description;
    if (data.logoUrl !== undefined) fieldsToUpdate.logoUrl = data.logoUrl;
    if (data.websiteUrl !== undefined) fieldsToUpdate.websiteUrl = data.websiteUrl;

    if (Object.keys(fieldsToUpdate).length === 0) {
      logger.debug('[token-update] No actual fields to update for token ${data.symbol}, though validation should have caught empty updates.');
      return true; 
    }

    const originalFieldsUpdated = { ...fieldsToUpdate }; // Clone for event log, before adding lastUpdatedAt
    fieldsToUpdate.lastUpdatedAt = new Date().toISOString();

    const updateSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol, creator: sender }, 
      { $set: fieldsToUpdate }
    );

    if (!updateSuccess) {
      logger.error(`[token-update] Failed to update token ${data.symbol}.`);
      return false;
    }

    logger.debug(`[token-update] Token ${data.symbol} updated successfully by ${sender}. Fields updated: ${Object.keys(originalFieldsUpdated).join(', ')}`);
    
    // Log event
    const eventDocument = {
        type: 'tokenUpdate',
        timestamp: new Date().toISOString(), 
        actor: sender,
        data: {
            symbol: data.symbol,
            updatedFields: originalFieldsUpdated // Log only the fields that were actually changed
        }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[token-update] CRITICAL: Failed to log tokenUpdate event for ${data.symbol}: ${err || 'no result'}. Transaction completed but event missing.`);
            }
            resolve();
        });
    });

    return true;

  } catch (error) {
    logger.error(`[token-update] Error processing token update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 