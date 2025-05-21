import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Using shared validation module
import { TokenMintData } from './token-interfaces.js'; // Import from new interfaces file

// Renamed to avoid conflict with imported 'validate' module
export async function validateTx(data: TokenMintData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.to || typeof data.amount !== 'number') {
      logger.warn('[token-mint] Invalid data: Missing required fields (symbol, to, amount).');
      return false;
    }

    // Validate symbol format (e.g., 3-10 uppercase letters)
    if (!validate.string(data.symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[token-mint] Invalid token symbol format: ${data.symbol}.`);
      return false;
    }

    // Validate recipient account name (general string validation, e.g., 3-16 chars, specific regex if any)
    // Assuming a generic string validation for account names here.
    // You might have a more specific validator or regex for account names.
    if (!validate.string(data.to, 16, 3)) { // Example: 3-16 chars for account name
      logger.warn(`[token-mint] Invalid recipient account name format: ${data.to}.`);
      return false;
    }

    // Validate amount (must be a positive integer)
    if (!validate.integer(data.amount, false, false, undefined, 1)) {
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

    if (token.creator !== sender) {
      logger.warn(`[token-mint] Sender ${sender} is not authorized to mint token ${data.symbol}. Only creator ${token.creator} can mint.`);
      return false;
    }

    // Check if minting this amount would exceed maxSupply
    const newPotentialSupply = token.currentSupply + data.amount;
    if (newPotentialSupply > token.maxSupply) {
      logger.warn(`[token-mint] Minting ${data.amount} ${data.symbol} would exceed max supply of ${token.maxSupply}. Current supply: ${token.currentSupply}.`);
      return false;
    }
    
    const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
    if (!recipientAccount) {
      // Depending on policy: auto-create account or fail.
      // For now, assume recipient account must exist.
      logger.warn(`[token-mint] Recipient account ${data.to} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[token-mint] Error validating token mint for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: TokenMintData, sender: string): Promise<boolean> {
  try {
    // 1. Update token's currentSupply
    const tokenUpdateSuccess = await cache.updateOnePromise(
      'tokens',
      { _id: data.symbol }, 
      { $inc: { currentSupply: data.amount } }
    );

    if (!tokenUpdateSuccess) {
      logger.error(`[token-mint] Failed to update current supply for token ${data.symbol}.`);
      return false;
    }

    // 2. Update recipient's balance
    const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
    if (!recipientAccount) {
      logger.error(`[token-mint] Recipient account ${data.to} not found during processing, though validation should have caught this.`);
      await cache.updateOnePromise('tokens', { _id: data.symbol }, { $inc: { currentSupply: -data.amount } }); // Attempt rollback
      return false;
    }

    const currentTokens = recipientAccount.tokens || {};
    currentTokens[data.symbol] = (currentTokens[data.symbol] || 0) + data.amount;

    const balanceUpdateSuccess = await cache.updateOnePromise(
      'accounts',
      { name: data.to }, 
      { $set: { tokens: currentTokens } }
    );

    if (!balanceUpdateSuccess) {
      logger.error(`[token-mint] Failed to update token balance for account ${data.to} for token ${data.symbol}.`);
      await cache.updateOnePromise('tokens', { _id: data.symbol }, { $inc: { currentSupply: -data.amount } });
      return false;
    }

    logger.debug(`[token-mint] Successfully minted ${data.amount} ${data.symbol} to ${data.to} by ${sender}.`);

    // Log event
    const eventDocument = {
      type: 'tokenMint',
      timestamp: new Date().toISOString(),
      actor: sender, // Creator who initiated the mint
      data: {
        symbol: data.symbol,
        to: data.to,
        amount: data.amount
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[token-mint] CRITICAL: Failed to log tokenMint event for ${data.symbol} to ${data.to}: ${err || 'no result'}. Transaction completed but event missing.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[token-mint] Error processing token mint for ${data.symbol} by ${sender}: ${error}`);
    // Attempt to rollback token supply if an error occurs mid-process
    // This is a simple attempt; a more robust system might use transactions or a saga pattern.
    try {
        await cache.updateOnePromise('tokens', { _id: data.symbol, currentSupply: { $gte: data.amount } }, { $inc: { currentSupply: -data.amount } });
        logger.debug(`[token-mint] Rollback attempt for ${data.symbol} supply due to error during mint processing.`);
    } catch (rollbackError) {
        logger.error(`[token-mint] CRITICAL: Failed to rollback token supply for ${data.symbol} after error: ${rollbackError}`);
    }
    return false;
  }
} 