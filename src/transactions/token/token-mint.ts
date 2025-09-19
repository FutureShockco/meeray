import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenTransferData } from './token-interfaces.js';
import config from '../../config.js';
import { toDbString, toBigInt } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { adjustBalance } from '../../utils/account.js';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.amount || !data.to) {
      logger.warn('[token-mint:validation] Invalid data: Missing required fields (symbol, amount, to).');
      return false;
    }
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[token-mint:validation] Invalid token symbol format: ${data.symbol}.`);
      return false;
    }
    if (!validate.string(data.to, 16, 3)) {
      logger.warn(`[token-mint:validation] Invalid recipient account name format: ${data.to}.`);
      return false;
    }
    if (!validate.bigint(data.amount, false, false, BigInt(1))) {
      logger.warn(`[token-mint:validation] Invalid amount: ${data.amount}. Must be a positive integer.`);
      return false;
    }
    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.warn(`[token-mint:validation] Token ${data.symbol} not found.`);
      return false;
    }
    if (!token.mintable) {
      logger.warn(`[token-mint:validation] Token ${data.symbol} is not mintable.`);
      return false;
    }
    const currentSupplyBigInt = toBigInt(token.currentSupply || 0);
    const maxSupplyBigInt = toBigInt(token.maxSupply);
    const amountBigInt = toBigInt(data.amount);
    if ((currentSupplyBigInt + amountBigInt) > maxSupplyBigInt) {
      logger.warn(`[token-mint:validation] Mint would exceed max supply for ${data.symbol}.`);
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`[token-mint:validation] Sender account ${sender} not found.`);
      return false;
    }
    if (sender !== token.issuer) {
      logger.warn(`[token-mint:validation] Only token issuer can mint. Sender: ${sender}, Issuer: ${token.issuer}`);
      return false;
    }
    if (sender !== data.to) {
      const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
      if (!recipientAccount) {
        logger.warn(`[token-mint:validation] Recipient account ${data.to} not found.`);
        return false;
      }
    }
    return true;
  } catch (error) {
    logger.error(`[token-mint:validation] Error validating: ${error}`);
    return false;
  }
}

export async function process(data: TokenTransferData, sender: string, id: string): Promise<boolean> {
  try {
    const tokenFromCache = (await cache.findOnePromise('tokens', { _id: data.symbol })) as any;
    const newSupply = toBigInt(tokenFromCache.currentSupply || 0) + toBigInt(data.amount);
    const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
    const currentBalanceStr = recipientAccount!.balances?.[data.symbol] || '0';
    const newBalance = toBigInt(currentBalanceStr) + toBigInt(data.amount);
    const adjustedBalance = await adjustBalance(data.to, data.symbol, newBalance);
    if (!adjustedBalance) {
      logger.error(`[token-mint:process] Failed to adjust balance for ${data.to} when minting ${toBigInt(data.amount).toString()} ${data.symbol}.`);
      return false;
    }
    await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol },
      { $set: { currentSupply: toDbString(newSupply) } }
    );
    await logEvent('token', 'mint', sender, {
      symbol: data.symbol,
      to: data.to,
      amount: toDbString(toBigInt(data.amount)),
      newSupply: toDbString(newSupply)
    });
    return true;
  } catch (error) {
    logger.error(`[token-mint:process] Error: ${error}`);
    return false;
  }
} 