import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { TokenUpdateData } from './token-interfaces.js'; // Import from new interfaces file
import config from '../../config.js';
import { logTransactionEvent } from '../../utils/event-logger.js'; // Import the new event logger

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

    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
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

export async function process(transaction: { data: TokenUpdateData, sender: string, _id: string }): Promise<boolean> {
  const { data: updatePayload, sender, _id: transactionId } = transaction;
  try {
    const fieldsToUpdate: Partial<Pick<TokenUpdateData, 'name' | 'description' | 'logoUrl' | 'websiteUrl'>> & { lastUpdatedAt?: string } = {};
    
    if (updatePayload.name !== undefined) fieldsToUpdate.name = updatePayload.name;
    if (updatePayload.description !== undefined) fieldsToUpdate.description = updatePayload.description;
    if (updatePayload.logoUrl !== undefined) fieldsToUpdate.logoUrl = updatePayload.logoUrl;
    if (updatePayload.websiteUrl !== undefined) fieldsToUpdate.websiteUrl = updatePayload.websiteUrl;

    if (Object.keys(fieldsToUpdate).length === 0) {
      logger.debug(`[token-update] No actual fields to update for token ${updatePayload.symbol}, though validation should have caught empty updates.`);
      return true; 
    }

    const originalFieldsUpdated = { ...fieldsToUpdate }; // Clone for event log, before adding lastUpdatedAt
    fieldsToUpdate.lastUpdatedAt = new Date().toISOString();

    const updateSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: updatePayload.symbol, creator: sender }, 
      { $set: fieldsToUpdate }
    );

    if (!updateSuccess) {
      logger.error(`[token-update] Failed to update token ${updatePayload.symbol}.`);
      return false;
    }

    logger.debug(`[token-update] Token ${updatePayload.symbol} updated successfully by ${sender}. Fields updated: ${Object.keys(originalFieldsUpdated).join(', ')}`);
    
    // Log event using the new centralized logger
    const eventData = {
        symbol: updatePayload.symbol,
        updatedFields: originalFieldsUpdated 
    };
    // Pass the transactionId to link the event to the original transaction
    await logTransactionEvent('tokenUpdate', sender, eventData, transactionId);

    return true;

  } catch (error) {
    logger.error(`[token-update] Error processing token update for ${updatePayload.symbol} by ${sender}: ${error}`);
    return false;
  }
} 