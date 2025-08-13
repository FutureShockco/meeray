import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import validate from '../../validation/index.js';
import { TokenData } from './token-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { adjustBalance } from '../../utils/account.js';
import transaction from '../../transaction.js';

export async function validateTx(data: TokenData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.name || data.maxSupply === undefined) {
      logger.warn('[token-create] Invalid data: Missing required fields (symbol, name, maxSupply).');
      return false;
    }
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[token-create] Invalid symbol format.');
      return false;
    }
    if (data.symbol.startsWith('LP_')) {
      logger.warn('[token-create] Token symbol cannot start with "LP_". This prefix is reserved for liquidity pool tokens.');
      return false;
    }
    if (!validate.string(data.name, 50, 1)) {
      logger.warn('[token-create] Invalid name length (must be 1-50 characters).');
      return false;
    }
    if (data.precision !== undefined && !validate.integer(data.precision, true, false, 18, 0)) {
      logger.warn('[token-create] Invalid precision (must be 0-18).');
      return false;
    }
    if (!validate.bigint(data.maxSupply, false, false, BigInt(1))) {
      logger.warn('[token-create] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }
    if (data.initialSupply !== undefined && BigInt(data.initialSupply) < BigInt(0)) {
      logger.warn('[token-create] Invalid initialSupply. Must be non-negative.');
      return false;
    }
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
    const existingToken = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (existingToken) {
      logger.warn(`[token-create] Token with symbol ${data.symbol} already exists.`);
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (BigInt(senderAccount!.balances?.[config.nativeTokenSymbol] || '0') < BigInt(config.tokenCreationFee)) {
      logger.warn(`[token-create] Sender account ${sender} does not have enough balance to create a token.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`[token-create] Error validating token creation: ${error}`);
    return false;
  }
}

export async function process(data: TokenData, sender: string, id: string): Promise<boolean> {

  try {
    const effectivePrecision = data.precision === undefined ? 8 : data.precision;
    const initialSupply = toBigInt(data.initialSupply || 0);
    const tokenToStore: TokenData = {
      _id: data.symbol,
      symbol: data.symbol,
      name: data.name,
      issuer: sender,
      precision: effectivePrecision,
      maxSupply: toDbString(toBigInt(data.maxSupply || '0')),
      currentSupply: toDbString(initialSupply),
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      description: data.description || '',
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      createdAt: new Date().toISOString()
    };

    await cache.insertOnePromise('tokens', tokenToStore);

    if (initialSupply > BigInt(0)) {
      await cache.updateOnePromise(
        'accounts',
        { name: sender },
        { $set: { [`balances.${tokenToStore._id}`]: toDbString(initialSupply) } }
      );
    }
    await adjustBalance(sender, config.nativeTokenSymbol, BigInt(-config.tokenCreationFee));
    await transaction.adjustWitnessWeight(sender, BigInt(config.tokenCreationFee), (success) => {});
    logger.info(`[token-create] Token ${tokenToStore._id} created successfully by ${sender}.`);
    return true;

  } catch (error) {
    logger.error(`[token-create] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 