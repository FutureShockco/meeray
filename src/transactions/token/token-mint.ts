import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenMintData } from './token-interfaces.js';
import config from '../../config.js';
import { toBigInt } from '../../utils/bigint-utils.js';

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
    if (!validate.bigint(data.amount, false, false, undefined, BigInt(1))) {
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

    if (token.currentSupply + data.amount > token.maxSupply) {
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

    const tokenFromCache = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!tokenFromCache) {
      logger.error(`[token-mint:process] Token ${data.symbol} not found`);
      return false;
    }
    if (!tokenFromCache.mintable) {
      logger.error(`[token-mint:process] Token ${data.symbol} is not mintable. This should have been caught by validateTx.`);
      return false;
    }
    if (sender !== tokenFromCache.issuer) {
      logger.error(`[token-mint:process] Only token issuer can mint. Sender: ${sender}, Issuer: ${tokenFromCache.issuer}. This should have been caught by validateTx.`);
      return false;
    }

    const newSupply = tokenFromCache.currentSupply + data.amount;

    if (newSupply > tokenFromCache.maxSupply) {
      logger.error(`[token-mint:process] Mint would exceed max supply for ${data.symbol}. Current: ${tokenFromCache.currentSupply}, Amount: ${data.amount}, Max: ${tokenFromCache.maxSupply}. This should have been caught by validateTx.`);
      return false;
    }

    const updateTokenSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol },
      { $set: { currentSupply: newSupply } }
    );

    if (!updateTokenSuccess) {
      logger.error(`[token-mint:process] Failed to update token supply for ${data.symbol}`);
      return false;
    }

    const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
    if (!recipientAccount) {
      logger.error(`[token-mint:process] Recipient account ${data.to} not found. Cannot mint to non-existent account.`);
      await cache.updateOnePromise(
        'tokens',
        { _id: data.symbol },
        { $set: { currentSupply: tokenFromCache.currentSupply } }
      );
      return false;
    }

    const currentBalanceStr = recipientAccount.balances?.[data.symbol] || '0';
    const currentBalance = toBigInt(currentBalanceStr);
    const newBalance = currentBalance + data.amount;

    const updateBalanceSuccess = await cache.updateOnePromise(
      'accounts',
      { name: data.to },
      { $set: { [`balances.${data.symbol}`]: newBalance } }
    );

    if (!updateBalanceSuccess) {
      logger.error(`[token-mint:process] Failed to update balance for ${data.to}. Rolling back token supply.`);
      await cache.updateOnePromise(
        'tokens',
        { _id: data.symbol },
        { $set: { currentSupply: tokenFromCache.currentSupply } }
      );
      return false;
    }
    logger.info(`[token-mint:process] Minted ${data.amount} of ${data.symbol} to ${data.to} by ${sender}. New supply: ${newSupply}.`);
    return true;
  } catch (error) {
    logger.error(`[token-mint:process] Error: ${error}`);
    return false;
  }
} 