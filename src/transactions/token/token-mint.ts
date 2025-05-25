import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { TokenMintData, TokenMintDataDB } from './token-interfaces.js';
import config from '../../config.js';
import { convertToBigInt, convertToString, toString } from '../../utils/bigint-utils.js';

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

    if (sender !== token.creator) {
      logger.warn(`[token-mint] Only token creator can mint. Sender: ${sender}, Creator: ${token.creator}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-mint] Error validating: ${error}`);
    return false;
  }
}

export async function verifyTokenMint(sender: string, data: TokenMintDataDB): Promise<boolean> {
    try {
        // Convert string inputs to BigInt for verification
        const mintData = convertToBigInt<TokenMintData>(data, NUMERIC_FIELDS);

        // Get token info
        const token = await cache.findOnePromise('tokens', { symbol: data.symbol });
        if (!token) {
            logger.error(`[verifyTokenMint] Token ${data.symbol} not found`);
            return false;
        }

        // Convert token amounts to BigInt
        const tokenData = convertToBigInt(token, ['maxSupply', 'currentSupply']);

        // Verify mint amount
        if (!validate.bigint(mintData.amount, false, false, undefined, BigInt(1))) {
            logger.error(`[verifyTokenMint] Invalid mint amount: ${mintData.amount}`);
            return false;
        }

        // Check if minting would exceed max supply
        if (tokenData.currentSupply + mintData.amount > tokenData.maxSupply) {
            logger.error(`[verifyTokenMint] Mint would exceed max supply for ${data.symbol}`);
            return false;
        }

        // Verify sender is token creator
        if (sender !== token.creator) {
            logger.error(`[verifyTokenMint] Only token creator can mint. Sender: ${sender}, Creator: ${token.creator}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[verifyTokenMint] Error: ${error}`);
        return false;
    }
}

export async function processTokenMint(sender: string, data: TokenMintDataDB): Promise<boolean> {
    try {
        // Convert string inputs to BigInt for processing
        const mintData = convertToBigInt<TokenMintData>(data, NUMERIC_FIELDS);

        // Update token supply
        const token = await cache.findOnePromise('tokens', { symbol: data.symbol });
        if (!token) {
            logger.error(`[processTokenMint] Token ${data.symbol} not found`);
            return false;
        }

        const tokenData = convertToBigInt(token, ['maxSupply', 'currentSupply']);
        const newSupply = tokenData.currentSupply + mintData.amount;

        const updateTokenSuccess = await cache.updateOnePromise(
            'tokens',
            { symbol: data.symbol },
            { $set: { currentSupply: toString(newSupply) } }
        );

        if (!updateTokenSuccess) {
            logger.error(`[processTokenMint] Failed to update token supply for ${data.symbol}`);
            return false;
        }

        // Update recipient balance with proper padding
        const updateBalanceSuccess = await cache.updateOnePromise(
            'accounts',
            { name: data.to },
            { $inc: { [`balances.${data.symbol}`]: toString(mintData.amount) } }
        );

        if (!updateBalanceSuccess) {
            logger.error(`[processTokenMint] Failed to update balance for ${data.to}`);
            return false;
        }

        // Log event
        const eventDocument = {
            _id: Date.now().toString(36),
            type: 'tokenMint',
            timestamp: new Date().toISOString(),
            actor: sender,
            data: {
                symbol: data.symbol,
                to: data.to,
                amount: toString(mintData.amount),
                newSupply: toString(newSupply)
            }
        };

        await new Promise<void>((resolve) => {
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[processTokenMint] Failed to log event: ${err || 'no result'}`);
                }
                resolve();
            });
        });

        return true;
    } catch (error) {
        logger.error(`[processTokenMint] Error: ${error}`);
        return false;
    }
} 