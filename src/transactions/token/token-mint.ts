import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenMintData, TokenMintDataDB } from './token-interfaces.js';
import config from '../../config.js';
import { convertToBigInt, convertToString, toString, toBigInt } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS: Array<keyof TokenMintData> = ['amount'];

export async function validateTx(data: TokenMintDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amount to BigInt for validation
    const mintData = convertToBigInt<TokenMintData>(data, NUMERIC_FIELDS);

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
    if (!validate.bigint(mintData.amount, false, false, undefined, BigInt(1))) {
      logger.warn(`[token-mint] Invalid amount: ${mintData.amount}. Must be a positive integer.`);
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

    // Convert token values to BigInt for comparison
    const tokenData = convertToBigInt(token, ['maxSupply', 'currentSupply']);
    if (tokenData.currentSupply + mintData.amount > tokenData.maxSupply) {
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

export async function process(data: TokenMintDataDB, sender: string, id: string): Promise<boolean> {
  try {
    const mintData = convertToBigInt<TokenMintData>(data, NUMERIC_FIELDS);

    const tokenFromCache = await cache.findOnePromise('tokens', { _id: mintData.symbol });
    if (!tokenFromCache) {
      logger.error(`[token-mint:process] Token ${mintData.symbol} not found`);
      return false;
    }
    if (!tokenFromCache.mintable) {
      logger.error(`[token-mint:process] Token ${mintData.symbol} is not mintable. This should have been caught by validateTx.`);
      return false;
    }
    if (sender !== tokenFromCache.issuer) {
      logger.error(`[token-mint:process] Only token issuer can mint. Sender: ${sender}, Issuer: ${tokenFromCache.issuer}. This should have been caught by validateTx.`);
      return false;
    }

    const tokenData = convertToBigInt(tokenFromCache, ['maxSupply', 'currentSupply']);
    const newSupply = tokenData.currentSupply + mintData.amount;

    if (newSupply > tokenData.maxSupply) {
      logger.error(`[token-mint:process] Mint would exceed max supply for ${mintData.symbol}. Current: ${tokenData.currentSupply}, Amount: ${mintData.amount}, Max: ${tokenData.maxSupply}. This should have been caught by validateTx.`);
      return false;
    }

    const updateTokenSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: mintData.symbol },
      { $set: { currentSupply: toString(newSupply) } }
    );

    if (!updateTokenSuccess) {
      logger.error(`[token-mint:process] Failed to update token supply for ${mintData.symbol}`);
      return false;
    }

    const recipientAccount = await cache.findOnePromise('accounts', { name: mintData.to });
    if (!recipientAccount) {
      logger.error(`[token-mint:process] Recipient account ${mintData.to} not found. Cannot mint to non-existent account.`);
      await cache.updateOnePromise(
        'tokens',
        { _id: mintData.symbol },
        { $set: { currentSupply: toString(tokenData.currentSupply) } }
      );
      return false;
    }

    const currentBalanceStr = recipientAccount.balances?.[mintData.symbol] || '0';
    const currentBalance = toBigInt(currentBalanceStr);
    const newBalance = currentBalance + mintData.amount;

    const updateBalanceSuccess = await cache.updateOnePromise(
      'accounts',
      { name: mintData.to },
      { $set: { [`balances.${mintData.symbol}`]: toString(newBalance) } }
    );

    if (!updateBalanceSuccess) {
      logger.error(`[token-mint:process] Failed to update balance for ${mintData.to}. Rolling back token supply.`);
      await cache.updateOnePromise(
        'tokens',
        { _id: mintData.symbol },
        { $set: { currentSupply: toString(tokenData.currentSupply) } }
      );
      return false;
    }

    const eventData = {
      symbol: mintData.symbol,
      to: mintData.to,
      amount: toString(mintData.amount),
      newSupply: toString(newSupply)
    };
    await logTransactionEvent('tokenMint', sender, eventData, id);

    return true;
  } catch (error) {
    logger.error(`[token-mint:process] Error: ${error}`);
    return false;
  }
} 