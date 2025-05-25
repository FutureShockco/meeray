import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js'; // Assuming config holds nativeToken symbol, etc.
import validate from '../../validation/index.js'; // Corrected import based on index.d.ts
import { TokenCreateData, TokenCreateDataDB } from './token-interfaces.js'; // Import from new interfaces file
import { convertToBigInt, convertToString, toString, setTokenDecimals } from '../../utils/bigint-utils.js';

const NUMERIC_FIELDS: Array<keyof TokenCreateData> = ['maxSupply', 'initialSupply', 'currentSupply'];

export async function validateTx(data: TokenCreateDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amount to BigInt for validation
    const tokenData = convertToBigInt<TokenCreateData>(data, NUMERIC_FIELDS);

    // Basic required field checks
    if (!data.symbol || !data.name || !data.maxSupply) {
      logger.warn('[token-create] Invalid data: Missing required fields (symbol, name, maxSupply).');
      return false;
    }

    // symbol: 3-10 chars, uppercase letters and numbers only
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[token-create] Invalid symbol format.');
      return false;
    }

    // name: 1-50 chars
    if (!validate.string(data.name, 50, 1)) {
      logger.warn('[token-create] Invalid name length (must be 1-50 characters).');
      return false;
    }

    // precision: 0-18
    if (data.precision !== undefined && !validate.integer(data.precision, true, false, 18, 0)) {
      logger.warn('[token-create] Invalid precision (must be 0-18).');
      return false;
    }

    // maxSupply: must be positive bigint (min 1)
    if (!validate.bigint(tokenData.maxSupply, false, false, undefined, BigInt(1))) {
      logger.warn('[token-create] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }
    
    if (tokenData.initialSupply !== undefined) {
      // initialSupply: must be <= maxSupply if provided
      if (!validate.bigint(tokenData.initialSupply, true, false, tokenData.maxSupply)) {
        logger.warn('[token-create] Invalid initialSupply. Must be <= maxSupply.');
        return false;
      }
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

    const existingToken = await cache.findOnePromise('tokens', { symbol: data.symbol });
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

export async function verifyTokenCreate(sender: string, data: TokenCreateDataDB): Promise<boolean> {
    try {
        // Convert string inputs to BigInt for verification
        const tokenData = convertToBigInt<TokenCreateData>(data, NUMERIC_FIELDS);

        // Verify token amounts
        if (!validate.bigint(tokenData.maxSupply, false, false, undefined, BigInt(1))) {
            logger.error(`[verifyTokenCreate] Invalid maxSupply: ${tokenData.maxSupply}`);
            return false;
        }

        if (tokenData.initialSupply !== undefined && 
            !validate.bigint(tokenData.initialSupply, true, false, tokenData.maxSupply)) {
            logger.error(`[verifyTokenCreate] Invalid initialSupply: ${tokenData.initialSupply}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[verifyTokenCreate] Error: ${error}`);
        return false;
    }
}

export async function process(sender: string, data: TokenCreateDataDB): Promise<boolean> {
    try {
        // Convert string inputs to BigInt for processing
        const tokenData = convertToBigInt<TokenCreateData>(data, NUMERIC_FIELDS);

        // Set token decimals in the global registry
        setTokenDecimals(data.symbol, data.precision || 8);

        // Create token document with proper padding
        const tokenDocument: TokenCreateData = {
            ...tokenData,
            creator: sender,
            precision: data.precision || 8,
            currentSupply: tokenData.initialSupply || BigInt(0),
            mintable: data.mintable || false,
            burnable: data.burnable || false,
            description: data.description,
            logoUrl: data.logoUrl,
            websiteUrl: data.websiteUrl
        };

        // Convert BigInt values to strings for database storage with proper padding
        const tokenDocumentDB = convertToString<TokenCreateData>(tokenDocument, NUMERIC_FIELDS);

        // Store in database
        const insertSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('tokens', tokenDocumentDB, (err, result) => {
                if (err || !result) {
                    logger.error(`[token-create] Failed to insert token ${data.symbol}`);
                    resolve(false);
                }
                resolve(true);
            });
        });

        if (!insertSuccess) {
            logger.error(`[token-create] Failed to insert token ${data.symbol}`);
            return false;
        }

        // Create initial balance for token creator if initialSupply > 0
        if (tokenData.initialSupply && tokenData.initialSupply > BigInt(0)) {
            const updateSuccess = await cache.updateOnePromise(
                'accounts',
                { name: sender },
                { $set: { [`balances.${data.symbol}`]: toString(tokenData.initialSupply) } }
            );

            if (!updateSuccess) {
                logger.error(`[token-create] Failed to set initial balance for ${sender}`);
                return false;
            }
        }

        // Log event
        const eventDocument = {
            type: 'tokenCreate',
            actor: sender,
            data: {
                symbol: data.symbol,
                name: data.name,
                precision: data.precision || 8,
                maxSupply: tokenDocumentDB.maxSupply,
                initialSupply: tokenDocumentDB.initialSupply,
                mintable: data.mintable,
                burnable: data.burnable
            }
        };

        await new Promise<void>((resolve) => {
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[token-create] Failed to log tokenCreate event for ${data.symbol}: ${err || 'no result'}`);
                }
                resolve();
            });
        });

        return true;
    } catch (error) {
        logger.error(`[token-create] Error processing token creation: ${error}`);
        return false;
    }
} 