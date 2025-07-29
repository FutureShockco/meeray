import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import validate from '../../validation/index.js';
import { TokenData } from './token-interfaces.js';
import { setTokenDecimals, amountToString } from '../../utils/bigint.js';

export async function validateTx(data: TokenData, sender: string): Promise<boolean> {
  try {

    if (!data.symbol || !data.name || data.maxSupply === undefined) {
      logger.warn('[token-create] Invalid data: Missing required fields (symbol, name, maxSupply).');
      return false;
    }

    // symbol: 3-10 chars, uppercase letters and numbers only
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[token-create] Invalid symbol format.');
      return false;
    }

    // Prevent symbols starting with 'LP_'
    if (data.symbol.startsWith('LP_')) {
      logger.warn('[token-create] Token symbol cannot start with "LP_". This prefix is reserved for liquidity pool tokens.');
      return false;
    }

    // name: 1-50 chars
    if (!validate.string(data.name, 50, 1)) {
      logger.warn('[token-create] Invalid name length (must be 1-50 characters).');
      return false;
    }

    // precision: 0-18 (is a number, not BigInt)
    if (data.precision !== undefined && !validate.integer(data.precision, true, false, 18, 0)) {
      logger.warn('[token-create] Invalid precision (must be 0-18).');
      return false;
    }

    // maxSupply: must be positive bigint (min 1)
    if (!validate.bigint(data.maxSupply, false, false, undefined, BigInt(1))) {
      logger.warn('[token-create] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }

    // Ensure initialSupply is non-negative if provided
    if (data.initialSupply !== undefined && BigInt(data.initialSupply) < BigInt(0)) {
      logger.warn('[token-create] Invalid initialSupply. Must be non-negative.');
      return false;
    }
    // Ensure initialSupply <= maxSupply
    if (data.initialSupply !== undefined && data.maxSupply !== undefined && BigInt(data.initialSupply) > BigInt(data.maxSupply)) {
      logger.warn('[token-create] Invalid initialSupply. Cannot be greater than maxSupply.');
      return false;
    }

    if (data.mintable !== undefined && typeof data.mintable !== 'boolean') {
      logger.warn('[token-create] Invalid mintable flag. Must be boolean.');
      return false;
    }

    if (data.burnable !== undefined && typeof data.burnable !== 'boolean') {
      logger.warn('[token-create] Invalid burnable flag. Must be boolean.');
      return false;
    }

    if (data.symbol === config.nativeToken) {
      logger.warn(`[token-create] Symbol ${data.symbol} is reserved.`);
      return false;
    }

    const existingToken = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (existingToken) {
      logger.warn(`[token-create] Token with symbol ${data.symbol} already exists.`);
      return false;
    }

    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`[token-create] Sender account ${sender} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-create] Error validating token creation: ${error}`);
    return false;
  }
}

export async function process(data: TokenData, sender: string, id: string): Promise<boolean> {

  console.log(data, sender);
  logger.debug(`[token-create] Processing token creation for ${data.symbol} by ${sender}`);

  try {
    const existingToken = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (existingToken) {
      logger.error(`[token-create] Token with symbol ${data.symbol} already exists.`);
      return false;
    }

    // Use 8 as the default precision if not provided
    const effectivePrecision = data.precision === undefined ? 8 : data.precision;
    if (effectivePrecision < 0 || effectivePrecision > 18) {
      logger.error(`[token-create] Invalid precision ${effectivePrecision} for token ${data.symbol}. Must be between 0 and 18.`);
      return false;
    }

    setTokenDecimals(data.symbol, effectivePrecision);

    const initialSupplyForLogic = BigInt(data.initialSupply || 0);
    const maxSupplyForLogic = BigInt(data.maxSupply || 0);

    if (initialSupplyForLogic < BigInt(0) || maxSupplyForLogic < BigInt(0)) {
      logger.error('[token-create] Initial supply and max supply cannot be negative.');
      return false;
    }

    if (maxSupplyForLogic !== BigInt(0) && initialSupplyForLogic > maxSupplyForLogic) {
      logger.error('[token-create] Initial supply cannot exceed max supply.');
      return false;
    }

    const tokenToStore: TokenData = {
      _id: data.symbol,
      symbol: data.symbol,
      name: data.name,
      issuer: sender,
      precision: effectivePrecision,
      maxSupply: amountToString(maxSupplyForLogic),
      currentSupply: amountToString(initialSupplyForLogic),
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      description: data.description || '',
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      createdAt: new Date().toISOString()
    };

    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('tokens', tokenToStore, (err, result) => {
        if (err || !result) {
          logger.error(`[token-create] Failed to insert token ${tokenToStore._id}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!insertSuccess) return false;

    if (initialSupplyForLogic > BigInt(0)) {
      const updateSuccess = await cache.updateOnePromise(
        'accounts',
        { name: sender },
        { $set: { [`balances.${tokenToStore._id}`]: initialSupplyForLogic } }
      );
      if (!updateSuccess) {
        logger.error(`[token-create] Failed to set initial balance for ${sender} for token ${tokenToStore._id}.`);
        return false;
      }
    }

    logger.info(`[token-create] Token ${tokenToStore._id} created successfully by ${sender}.`);
    return true;

  } catch (error) {
    logger.error(`[token-create] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 