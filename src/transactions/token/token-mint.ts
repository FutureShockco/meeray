import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenMintData } from './token-interfaces.js';
import config from '../../config.js';
import { toDbString, toBigInt } from '../../utils/bigint.js';

export async function validateTx(data: TokenMintData, sender: string): Promise<boolean> {
  try {

    if (!data.symbol || !data.to) {
      logger.warn('[token-mint] Invalid data: Missing required fields (symbol, to).');
      return false;
    }

    // Validate symbol format (e.g., 3-10 uppercase letters)
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[token-mint] Invalid token symbol format: ${data.symbol}.`);
      return false;
    }

    // Validate recipient account name
    if (!validate.string(data.to, 16, 3)) {
      logger.warn(`[token-mint] Invalid recipient account name format: ${data.to}.`);
      return false;
    }

    // Validate amount (must be a positive bigint)
    if (!validate.bigint(data.amount, false, false, BigInt(1))) {
      logger.warn(`[token-mint] Invalid amount: ${data.amount}. Must be a positive integer.`);
      return false;
    }

    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.warn(`[token-mint] Token ${data.symbol} not found.`);
      return false;
    }

    if (!token.mintable) {
      logger.warn(`[token-mint] Token ${data.symbol} is not mintable.`);
      return false;
    }

    const currentSupplyBigInt = toBigInt(token.currentSupply || 0);
    const maxSupplyBigInt = toBigInt(token.maxSupply);
    const amountBigInt = toBigInt(data.amount);
    
    if (currentSupplyBigInt + amountBigInt > maxSupplyBigInt) {
      logger.warn(`[token-mint] Mint would exceed max supply for ${data.symbol}.`);
      return false;
    }

    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`[token-mint] Sender account ${sender} not found.`);
      return false;
    }

    if (sender !== token.issuer) {
      logger.warn(`[token-mint] Only token issuer can mint. Sender: ${sender}, Issuer: ${token.issuer}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-mint] Error validating: ${error}`);
    return false;
  }
}

export async function process(data: TokenMintData, sender: string, id: string): Promise<boolean> {
  try {
    const tokenFromCache = (await cache.findOnePromise('tokens', { _id: data.symbol })) as any; // validateTx ensures existence
    const newSupply = toBigInt(tokenFromCache.currentSupply || 0) + toBigInt(data.amount);

    await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol },
      { $set: { currentSupply: toDbString(newSupply) } }
    );

    const recipientAccount = (await cache.findOnePromise('accounts', { name: data.to })) as any; // validateTx ensures account format; account upsert happens before

    const currentBalanceStr = recipientAccount.balances?.[data.symbol] || '0';
    const newBalance = toBigInt(currentBalanceStr) + toBigInt(data.amount);

    await cache.updateOnePromise(
      'accounts',
      { name: data.to },
      { $set: { [`balances.${data.symbol}`]: toDbString(newBalance) } }
    );
    
    logger.info(`[token-mint:process] Minted ${data.amount.toString()} of ${data.symbol} to ${data.to} by ${sender}. New supply: ${newSupply.toString()}.`);
    return true;
  } catch (error) {
    logger.error(`[token-mint:process] Error: ${error}`);
    return false;
  }
} 