import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import validate from '../../validation/index.js';
import { TokenData } from './token-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { adjustBalance } from '../../utils/account.js';
import transaction from '../../transaction.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: TokenData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.name || data.maxSupply === undefined || data.precision === undefined || data.initialSupply === undefined) {
      logger.warn('[token-create:validation] Invalid data: Missing required fields (symbol, name, maxSupply, precision, initialSupply).');
      return false;
    }
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[token-create:validation] Invalid symbol format.');
      return false;
    }
    if (data.symbol.startsWith('LP_')) {
      logger.warn('[token-create:validation] Token symbol cannot start with "LP_". This prefix is reserved for liquidity pool tokens.');
      return false;
    }
    if (!validate.string(data.name, 25, 1)) {
      logger.warn('[token-create:validation] Invalid name length (must be 1-25 characters).');
      return false;
    }
    if (!validate.integer(data.precision, true, false, 18, 0)) {
      logger.warn('[token-create:validation] Invalid precision (must be 0-18).');
      return false;
    }
    if (!validate.bigint(data.maxSupply, false, false, BigInt(1))) {
      logger.warn('[token-create:validation] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }
    if (!validate.bigint(data.initialSupply, false, false, BigInt(0))) {
      logger.warn('[token-create:validation] Invalid initialSupply. Must be non-negative.');
      return false;
    }
    if (BigInt(data.initialSupply) > BigInt(data.maxSupply)) {
      logger.warn('[token-create:validation] Invalid initialSupply. Cannot be greater than maxSupply.');
      return false;
    }
    if (data.mintable !== undefined && typeof data.mintable !== 'boolean') {
      logger.warn('[token-create:validation] Invalid mintable flag. Must be boolean.');
      return false;
    }
    if (data.burnable !== undefined && typeof data.burnable !== 'boolean') {
      logger.warn('[token-create:validation] Invalid burnable flag. Must be boolean.');
      return false;
    }
    if (data.description !== undefined) {
      if (!validate.string(data.description, 512, 0)) {
        logger.warn('[token-update] Invalid new description length (must be 0-500 characters).');
        return false;
      }
    }
    if (data.logoUrl !== undefined) {
      if (!validate.validateLogoUrl(data.logoUrl, 512)) {
        logger.warn('[token-update] Invalid new logoUrl format or length.');
        return false;
      }
    }
    if (data.websiteUrl !== undefined) {
      if (!validate.validateUrl(data.websiteUrl, 512)) {
        logger.warn('[token-update] Invalid new websiteUrl format or length.');
        return false;
      }
    }
    const existingToken = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (existingToken) {
      logger.warn(`[token-create:validation] Token with symbol ${data.symbol} already exists.`);
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (BigInt(senderAccount!.balances?.[config.nativeTokenSymbol] || '0') < BigInt(config.tokenCreationFee)) {
      logger.warn(`[token-create:validation] Sender account ${sender} does not have enough balance to create a token.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`[token-create:validation] Error validating token creation: ${error}`);
    return false;
  }
}

export async function process(data: TokenData, sender: string, id: string): Promise<boolean> {
  try {
    const initialSupply = toBigInt(data.initialSupply || 0);
    const tokenToStore: TokenData = {
      _id: data.symbol,
      symbol: data.symbol,
      name: data.name,
      issuer: sender,
      precision: data.precision,
      maxSupply: toDbString(toBigInt(data.maxSupply || '0')),
      currentSupply: toDbString(initialSupply),
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      description: data.description || '',
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      createdAt: new Date().toISOString()
    };
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (initialSupply > BigInt(0)) {
      const adjustedSupply = await adjustBalance(sender, tokenToStore.symbol, initialSupply);
      if (!adjustedSupply) {
        logger.error(`[token-create:process] Failed to adjust balance for ${sender} when creating token ${tokenToStore.symbol}.`);
        return false;
      }
    }
    const feeDeducted = await adjustBalance(sender, config.nativeTokenSymbol, BigInt(-config.tokenCreationFee));
    if (!feeDeducted) {
      logger.error(`[token-create:process] Failed to deduct token creation fee from ${sender}.`);
      return false;
    }
    const adjustedWitnessWeight = await transaction.adjustWitnessWeight(sender, BigInt(senderAccount!.balances?.[config.nativeTokenSymbol]) - BigInt(config.tokenCreationFee));
    if (!adjustedWitnessWeight) {
      logger.error(`[token-create:process] Failed to adjust witness weight for ${sender} after deducting token creation fee.`);
      return false;
    }
    await cache.insertOnePromise('tokens', tokenToStore);
    await logEvent('token', 'create', sender, {
      symbol: data.symbol,
      name: data.name,
      issuer: sender,
      precision: data.precision,
      maxSupply: toDbString(toBigInt(data.maxSupply || '0')),
      currentSupply: toDbString(initialSupply),
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
    });
    return true;
  } catch (error) {
    logger.error(`[token-create:process] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 