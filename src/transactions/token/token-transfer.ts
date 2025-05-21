import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; 
import config from '../../config.js'; 
import transaction from '../../transaction.js'; 
import { TokenTransferData } from './token-interfaces.js'; 

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null'; 

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.to || typeof data.amount !== 'number') {
      logger.warn('[token-transfer/burn] Invalid data: Missing required fields (symbol, to, amount).');
      return false;
    }

    // Token fetched early for multiple checks
    const token = await cache.findOnePromise('tokens', { _id: data.symbol });
    if (!token) {
      logger.warn(`[token-transfer/burn] Token ${data.symbol} not found.`);
      return false;
    }

    // Validations for symbol, recipient name format, amount
    if (!validate.string(data.symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[token-transfer/burn] Invalid token symbol format: ${data.symbol}.`);
      return false;
    }
    if (data.to !== BURN_ACCOUNT_NAME && !validate.string(data.to, 16, 3)) { 
      logger.warn(`[token-transfer/burn] Invalid recipient account name format: ${data.to}.`);
      return false;
    }
    if (!validate.integer(data.amount, false, false, undefined, 1)) { 
      logger.warn(`[token-transfer/burn] Invalid amount: ${data.amount}. Must be a positive integer.`);
      return false;
    }
    if (data.memo && typeof data.memo === 'string' && !validate.string(data.memo, 256, 1)) { 
        logger.warn('[token-transfer/burn] Invalid memo: Exceeds maximum length of 256 characters.');
        return false;
    }
    if (data.memo && typeof data.memo !== 'string') {
        logger.warn('[token-transfer/burn] Invalid memo: Must be a string if provided.');
        return false;
    }

    // If sending to burn account, check if token is burnable using token.burnable
    if (data.to === BURN_ACCOUNT_NAME) {
      if (!token.burnable) { // Use token.burnable
        logger.warn(`[token-transfer/burn] Token ${data.symbol} is not burnable. Cannot send to ${BURN_ACCOUNT_NAME}.`);
        return false;
      }
      const senderAccountForBurn = await cache.findOnePromise('accounts', { name: sender });
      if (!senderAccountForBurn) {
        logger.warn(`[token-transfer/burn] Sender account ${sender} not found for burning.`);
        return false;
      }
      const senderBalanceForBurn = (senderAccountForBurn.tokens && senderAccountForBurn.tokens[data.symbol]) || 0;
      if (senderBalanceForBurn < data.amount) {
        logger.warn(`[token-transfer/burn] Sender ${sender} has insufficient balance of ${data.symbol} to burn. Has ${senderBalanceForBurn}, needs ${data.amount}.`);
        return false;
      }
      if (token.currentSupply < data.amount) { // Use token.currentSupply
        logger.warn(`[token-transfer/burn] Burn amount ${data.amount} exceeds current total supply ${token.currentSupply} for token ${data.symbol}.`);
        return false;
      }
      return true; 
    }

    // Regular transfer validation
    if (sender === data.to) {
      logger.warn('[token-transfer] Sender and recipient cannot be the same account for regular transfer.');
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`[token-transfer] Sender account ${sender} not found.`);
      return false;
    }
    const senderBalance = (senderAccount.tokens && senderAccount.tokens[data.symbol]) || 0;
    if (senderBalance < data.amount) {
      logger.warn(`[token-transfer] Sender ${sender} has insufficient balance of ${data.symbol}. Has ${senderBalance}, needs ${data.amount}.`);
      return false;
    }
    const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
    if (!recipientAccount) {
      logger.warn(`[token-transfer] Recipient account ${data.to} not found.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`[token-transfer/burn] Error validating: ${error}`);
    return false;
  }
}

export async function process(data: TokenTransferData, sender: string): Promise<boolean> {
  let senderBalanceRestored = false;
  const isBurning = data.to === BURN_ACCOUNT_NAME;
  let originalSenderTokens: any = null; // Define here to be accessible in catch if needed, though primary use is in try block

  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount || !senderAccount.tokens || senderAccount.tokens[data.symbol] < data.amount) {
        logger.error(`[${isBurning?'token-burn':'token-transfer'}] Critical: Sender ${sender} account not found or insufficient balance during processing for ${data.symbol}.`);
        return false;
    }
    
    originalSenderTokens = { ...senderAccount.tokens }; // Snapshot for rollback
    const senderTokens = { ...senderAccount.tokens };
    senderTokens[data.symbol] -= data.amount;
    if (senderTokens[data.symbol] === 0) {
      delete senderTokens[data.symbol];
    }

    const senderUpdateSuccess = await cache.updateOnePromise(
      'accounts',
      { name: sender }, 
      { $set: { tokens: senderTokens } }
    );

    if (!senderUpdateSuccess) {
      logger.error(`[${isBurning?'token-burn':'token-transfer'}] Failed to update sender ${sender}'s balance for token ${data.symbol}.`);
      return false;
    }

    if (isBurning) {
      const tokenDataUpdate = {
          $inc: {
              currentSupply: -data.amount, 
              burntSupply: data.amount     
          }
      };
      const tokenUpdateSuccess = await cache.updateOnePromise(
        'tokens',
        { _id: data.symbol }, 
        tokenDataUpdate
      );
      if (!tokenUpdateSuccess) {
        logger.error(`[token-burn] Failed to update token ${data.symbol} supply details during burn.`);
        if (originalSenderTokens) await cache.updateOnePromise('accounts', { name: sender }, { $set: { tokens: originalSenderTokens } });
        senderBalanceRestored = true;
        return false;
      }
      if (data.symbol === config.nativeToken) {
        logger.debug(`[token-burn] Native token ${data.symbol} burnt. Adjusting node approval for sender.`);
        try {
          await transaction.adjustNodeAppr(sender, -data.amount, () => {
            logger.debug(`[token-burn] adjustNodeAppr callback for sender ${sender} after ECH burn.`);
          }); 
          logger.debug(`[token-burn] Node approval adjusted for sender ${sender} regarding ${data.symbol} burn.`);
        } catch (approvalError) {
          logger.error(`[token-burn] CRITICAL: Failed to adjust node approval for sender ${sender} after ${data.symbol} burn: ${approvalError}.`);
        }
      }
      logger.debug(`[token-burn] Successfully burnt ${data.amount} ${data.symbol} by ${sender}. Memo: ${data.memo || 'N/A'}`);
      const burnEvent = {
          type: 'tokenBurn',
          timestamp: new Date().toISOString(),
          actor: sender,
          data: { symbol: data.symbol, from: sender, amount: data.amount, memo: data.memo || null }
      };
      await new Promise<void>((resolve) => {
          cache.insertOne('events', burnEvent, (err, result) => {
              if (err || !result) logger.error(`[token-burn] CRITICAL: Failed to log tokenBurn event: ${err || 'no result'}`);
              resolve();
          });
      });
    } else {
      const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
      if (!recipientAccount) {
          logger.error(`[token-transfer] Critical: Recipient account ${data.to} not found during processing.`);
          if (originalSenderTokens) await cache.updateOnePromise('accounts', { name: sender }, { $set: { tokens: originalSenderTokens } });
          senderBalanceRestored = true;
          return false;
      }
      const recipientTokens = recipientAccount.tokens || {};
      recipientTokens[data.symbol] = (recipientTokens[data.symbol] || 0) + data.amount;
      const recipientUpdateSuccess = await cache.updateOnePromise(
        'accounts',
        { name: data.to }, 
        { $set: { tokens: recipientTokens } }
      );
      if (!recipientUpdateSuccess) {
        logger.error(`[token-transfer] Failed to update recipient ${data.to}'s balance for token ${data.symbol}.`);
        if (originalSenderTokens) await cache.updateOnePromise('accounts', { name: sender }, { $set: { tokens: originalSenderTokens } });
        senderBalanceRestored = true;
        return false;
      }
      if (data.symbol === config.nativeToken) {
        logger.debug(`[token-transfer] Native token ${data.symbol} transferred. Adjusting node approvals.`);
        try {
          await transaction.adjustNodeAppr(sender, -data.amount, () => {
            logger.debug(`[token-transfer] adjustNodeAppr callback for sender ${sender}.`);
          }); 
          await transaction.adjustNodeAppr(data.to, data.amount, () => {
            logger.debug(`[token-transfer] adjustNodeAppr callback for recipient ${data.to}.`);
          });   
          logger.debug(`[token-transfer] Node approvals adjusted for ${sender} and ${data.to}.`);
        } catch (approvalError) {
          logger.error(`[token-transfer] CRITICAL: Failed to adjust node approvals: ${approvalError}.`);
        }
      }
      logger.debug(`[token-transfer] Successfully transferred ${data.amount} ${data.symbol} from ${sender} to ${data.to}. Memo: ${data.memo || 'N/A'}`);
      const transferEvent = {
          type: 'tokenTransfer',
          timestamp: new Date().toISOString(),
          actor: sender,
          data: { symbol: data.symbol, from: sender, to: data.to, amount: data.amount, memo: data.memo || null }
      };
      await new Promise<void>((resolve) => {
          cache.insertOne('events', transferEvent, (err, result) => {
              if (err || !result) logger.error(`[token-transfer] CRITICAL: Failed to log tokenTransfer event: ${err || 'no result'}`);
              resolve();
          });
      });
    }
    return true;
  } catch (error) {
    logger.error(`[token-transfer/burn] Error processing: ${error}`);
    // General catch block rollback: attempt to restore sender's balance if not already handled and if original snapshot exists.
    if (!senderBalanceRestored && originalSenderTokens) { 
        try {
            await cache.updateOnePromise('accounts', {name: sender}, {$set: {tokens: originalSenderTokens}});
            logger.debug(`[token-transfer/burn] Attempted to restore sender balance for ${sender} due to error in main catch block, using original snapshot.`);
        } catch (restoreError) {
            logger.error(`[token-transfer/burn] CRITICAL: Failed to restore sender balance for ${sender} after error in main catch block: ${restoreError}`);
        }
    }
    return false;
  }
} 