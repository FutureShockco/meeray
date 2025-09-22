import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import validate from '../../validation/index.js';
import { TokenData } from './token-interfaces.js';
import { toDbString, setTokenDecimals } from '../../utils/bigint.js';
import { adjustUserBalance } from '../../utils/account.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: TokenData, sender: string): Promise<boolean> {
  try {
    if (!await validate.newToken(data)) return false;

    if (!await validate.userBalances(sender, [{ symbol: config.nativeTokenSymbol, amount: BigInt(config.tokenCreationFee) }])) return false;

    return true;
  } catch (error) {
    logger.error(`[token-create:validation] Error validating token creation: ${error}`);
    return false;
  }
}

export async function processTx(data: TokenData, sender: string, id: string): Promise<boolean> {
  try {
    const initialSupply = BigInt(data.initialSupply || 0);
    const tokenToStore: TokenData = {
      _id: data.symbol,
      symbol: data.symbol,
      name: data.name,
      issuer: sender,
      precision: data.precision,
      maxSupply: toDbString(data.maxSupply || 0),
      currentSupply: toDbString(initialSupply),
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      description: data.description || '',
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      createdAt: new Date().toISOString()
    };
    if (initialSupply > BigInt(0)) {
      const adjustedSupply = await adjustUserBalance(sender, tokenToStore.symbol, BigInt(initialSupply));
      if (!adjustedSupply) {
        logger.error(`[token-create:process] Failed to adjust balance for ${sender} when creating token ${tokenToStore.symbol}.`);
        return false;
      }
    }
    const feeDeducted = await adjustUserBalance(sender, config.nativeTokenSymbol, BigInt(-config.tokenCreationFee));
    if (!feeDeducted) {
      logger.error(`[token-create:process] Failed to deduct token creation fee from ${sender}.`);
      return false;
    }
    const newToken = await cache.insertOnePromise('tokens', tokenToStore);
    if (!newToken) {
      logger.error(`[token-create:process] Failed to store new token ${data.symbol} in the database.`);
      return false;
    }
    
    // Configure decimal precision for BigInt calculations
    setTokenDecimals(data.symbol, data.precision);
    const { logoUrl, websiteUrl, description, ...logToken } = tokenToStore;
    await logEvent('token', 'create', sender, logToken);
    return true;
  } catch (error) {
    logger.error(`[token-create:process] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 