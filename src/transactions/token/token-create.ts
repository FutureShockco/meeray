import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js'; // Assuming config holds nativeToken symbol, etc.
import validate from '../../validation/index.js'; // Corrected import based on index.d.ts
import { TokenCreateData } from './token-interfaces.js'; // Import from new interfaces file

export async function validateTx(data: TokenCreateData, sender: string): Promise<boolean> {
  try {
    // Validate required fields
    if (!data.symbol || !data.name || typeof data.precision !== 'number' || typeof data.maxSupply !== 'number') {
      logger.warn('[token-create] Invalid data: Missing required fields (symbol, name, precision, maxSupply)');
      return false;
    }

    // Use imported validation functions with correct signatures
    // validate.string(value: any, maxLength?: number, minLength?: number, allowedChars?: string)
    if (!validate.string(data.symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[token-create] Invalid symbol: ${data.symbol}. Must be 3-10 uppercase letters.`);
      return false;
    }
    // For name, we only had length checks before. The new validate.string can do that.
    // No specific allowedChars were defined for name, so pass undefined or omit.
    if (!validate.string(data.name, 50, 1)) {
      logger.warn('[token-create] Invalid name length (must be 1-50 characters).');
      return false;
    }
    
    // validate.integer(value: any, canBeZero?: boolean, canBeNegative?: boolean, max?: number, min?: number)
    if (!validate.integer(data.precision, true, false, 18, 0 )) { // precision: 0-18
      logger.warn('[token-create] Invalid precision. Must be integer between 0 and 18.');
      return false;
    }

    // maxSupply: must be positive integer (min 1)
    if (!validate.integer(data.maxSupply, false, false, undefined, 1)) { 
      logger.warn('[token-create] Invalid maxSupply. Must be a positive integer (min 1).');
      return false;
    }
    
    if (data.initialSupply !== undefined) {
      // initialSupply: non-negative integer (min 0)
      if (!validate.integer(data.initialSupply, true, false, data.maxSupply, 0)) { 
        logger.warn('[token-create] Invalid initialSupply. Must be a non-negative integer and not exceed maxSupply.');
        return false;
      }
      // The validate.integer above now includes max check against data.maxSupply
      // So, the separate check below is redundant if validate.integer handles it correctly.
      // if (data.initialSupply > data.maxSupply) {
      //   logger.warn('[token-create] InitialSupply cannot exceed maxSupply.');
      //   return false;
      // }
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
    logger.error(`[token-create] Error validating token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: TokenCreateData, sender: string): Promise<boolean> {
  try {
    const tokenDocument = {
      _id: data.symbol, // Use symbol as ID for tokens collection for easy lookup
      symbol: data.symbol,
      name: data.name,
      precision: data.precision,
      maxSupply: data.maxSupply,
      currentSupply: data.initialSupply || 0,
      creator: sender,
      createdAt: new Date().toISOString(),
      mintable: data.mintable === undefined ? false : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      description: data.description || '',
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      burntSupply: 0,
    };

    // Create the token
    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('tokens', tokenDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[token-create] Failed to insert token ${data.symbol} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!createSuccess) {
      // logger.error already called in the promise if it failed
      return false;
    }
    logger.info(`[token-create] Token ${data.symbol} created by ${sender} and inserted into cache.`);

    // If initialSupply is specified and greater than 0, mint it to the creator
    if (tokenDocument.currentSupply > 0) {
      const creatorAccount = await cache.findOnePromise('accounts', { name: sender });
      if (!creatorAccount) {
        // This should ideally not happen if validation passed or accounts are auto-created
        logger.error(`[token-create] Creator account ${sender} not found during initial supply minting for ${data.symbol}. This might indicate a consistency issue.`);
        // Decide if token creation should be rolled back or if this is a separate problem
        return false; // Or attempt to create account here if that's the desired flow
      }

      const currentTokens = creatorAccount.tokens || {};
      currentTokens[data.symbol] = (currentTokens[data.symbol] || 0) + tokenDocument.currentSupply;

      const updatePayload = { $set: { tokens: currentTokens } };
      if (creatorAccount.tokens === undefined) { // If tokens field didn't exist, $set will create it.
          // Optionally, can use $setOnInsert for first-time field creation if preferred by DB and cache logic
      }

      const balanceUpdateSuccess = await cache.updateOnePromise('accounts', { name: sender }, updatePayload);
      if (!balanceUpdateSuccess) {
        logger.error(`[token-create] Failed to update balance for creator ${sender} with initial supply of ${data.symbol}.`);
        // At this point, the token is created but initial supply minting failed.
        // Consider rollback logic or marking the token/transaction as partially failed.
        // For simplicity here, we'll return false, but a real system needs robust error handling/rollback.
        return false;
      }
      logger.info(`[token-create] Initial supply of ${tokenDocument.currentSupply} ${data.symbol} minted to creator ${sender}.`);
    }

    // Log event
    const eventDocument = {
      type: 'tokenCreate',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        symbol: tokenDocument.symbol,
        name: tokenDocument.name,
        precision: tokenDocument.precision,
        maxSupply: tokenDocument.maxSupply,
        initialSupply: tokenDocument.currentSupply,
        mintable: tokenDocument.mintable,
        burnable: tokenDocument.burnable,
        creator: tokenDocument.creator,
        description: tokenDocument.description,
        logoUrl: tokenDocument.logoUrl,
        websiteUrl: tokenDocument.websiteUrl
      }
    };

    // Using callback pattern for cache.insertOne, consistent with existing code
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[token-create] CRITICAL: Failed to log tokenCreate event for ${data.symbol}: ${err || 'no result'}. Transaction completed but event missing.`);
            }
            // Even if event logging fails, we resolve and let the main transaction succeed.
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[token-create] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 