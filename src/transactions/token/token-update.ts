import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { TokenUpdateData } from './token-interfaces.js'; // Import from new interfaces file
import config from '../../config.js';
import { logEvent } from '../../utils/event-logger.js';
// event logger removed

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

    if (token.issuer !== sender) {
      logger.warn(`[token-update] Sender ${sender} is not the issuer of token ${data.symbol}. Only issuer can update.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-update] Error validating token update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: TokenUpdateData, sender: string, id: string): Promise<boolean> {
  try {
    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.error(`[token-update:process] Token ${data.symbol} not found`);
      return false;
    }

    if (token.issuer !== sender) {
      logger.error(`[token-update:process] Only token issuer can update token. Sender: ${sender}, Issuer: ${token.issuer}`);
      return false;
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.websiteUrl !== undefined) updateData.websiteUrl = data.websiteUrl;

    if (Object.keys(updateData).length === 0) {
      logger.warn(`[token-update:process] No fields to update for token ${data.symbol}`);
      return false;
    }

    const updateSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol },
      { $set: updateData }
    );

    if (!updateSuccess) {
      logger.error(`[token-update:process] Failed to update token ${data.symbol}`);
      return false;
    }

    // Log event
    await logEvent('token', 'update', sender, {
      symbol: data.symbol,
      issuer: sender,
      updatedFields: updateData
    });

    logger.info(`[token-update:process] Token ${data.symbol} updated successfully by ${sender}`);
    return true;
  } catch (error) {
    logger.error(`[token-update:process] Error updating token ${data.symbol}: ${error}`);
    return false;
  }
} 