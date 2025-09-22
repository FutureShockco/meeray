import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenUpdateData } from './token-interfaces.js';
import config from '../../config.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: TokenUpdateData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol) {
      logger.warn('[token-update:validation] Invalid data: Missing required field (symbol).');
      return false;
    }
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[token-update:validation] Invalid token symbol format for lookup: ${data.symbol}.`);
      return false;
    }
    if (data.description === undefined && data.logoUrl === undefined && data.websiteUrl === undefined) {
      logger.warn('[token-update:validation] No updatable fields provided (name, description, logoUrl, websiteUrl).');
      return false;
    }
    if (data.description !== undefined && !validate.string(data.description, 512, 0)) {
      logger.warn('[token-update:validation] Invalid new description length (must be 0-500 characters).');
      return false;
    }
    if (data.logoUrl !== undefined && !validate.validateLogoUrl(data.logoUrl, 512)) {
      logger.warn('[token-update:validation] Invalid new logoUrl format or length.');
      return false;
    }
    if (data.websiteUrl !== undefined && !validate.validateUrl(data.websiteUrl, 512)) {
      logger.warn('[token-update:validation] Invalid new websiteUrl format or length.');
      return false;
    }
    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.warn(`[token-update:validation] Token ${data.symbol} not found.`);
      return false;
    }
    if (token.issuer !== sender) {
      logger.warn(`[token-update:validation] Sender ${sender} is not the issuer of token ${data.symbol}. Only issuer can update.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`[token-update:validation] Error validating token update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function processTx(data: TokenUpdateData, sender: string, id: string): Promise<boolean> {
  try {
    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.error(`[token-update:process] Token ${data.symbol} not found`);
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
    await logEvent('token', 'update', sender, {
      symbol: data.symbol,
      issuer: sender,
      updatedFields: updateData
    });
    return true;
  } catch (error) {
    logger.error(`[token-update:process] Error updating token ${data.symbol}: ${error}`);
    return false;
  }
} 