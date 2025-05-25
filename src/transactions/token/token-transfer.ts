import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import transaction from '../../transaction.js';
import { TokenTransferData, TokenTransferDataDB } from './token-interfaces.js';
import { convertToBigInt, convertToString, toString, getTokenDecimals } from '../../utils/bigint-utils.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';
const NUMERIC_FIELDS: Array<keyof TokenTransferData> = ['amount'];

export async function validateTx(data: TokenTransferDataDB, sender: string): Promise<boolean> {
    try {
        // Convert string amount to BigInt for validation
        const transferData = convertToBigInt<TokenTransferData>(data, NUMERIC_FIELDS);

        if (!data.symbol || !data.to) {
            logger.warn('[token-transfer] Invalid data: Missing required fields (symbol, to).');
            return false;
        }

        // Token fetched early for multiple checks
        const token = await cache.findOnePromise('tokens', { symbol: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer] Token ${data.symbol} not found.`);
            return false;
        }

        // Validations for symbol, recipient name format, amount
        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token-transfer] Invalid token symbol format: ${data.symbol}.`);
            return false;
        }

        if (data.to !== BURN_ACCOUNT_NAME && !validate.string(data.to, 16, 3)) {
            logger.warn(`[token-transfer] Invalid recipient account name format: ${data.to}.`);
            return false;
        }

        // Validate amount considering token precision
        const precision = token.precision || 8;
        const maxAmount = BigInt('9'.repeat(30 - precision)) * BigInt(10) ** BigInt(precision);
        
        if (!validate.bigint(transferData.amount, false, false, maxAmount, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${transferData.amount}. Must be a positive integer not exceeding ${maxAmount}.`);
            return false;
        }

        // Verify sender has sufficient balance
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[token-transfer] Sender account ${sender} not found.`);
            return false;
        }

        const senderBalance = convertToBigInt(senderAccount.balances?.[data.symbol] || '0', ['amount']);
        if (senderBalance.amount < transferData.amount) {
            logger.warn(`[token-transfer] Insufficient balance for ${sender}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return false;
    }
}

export async function process(sender: string, data: TokenTransferDataDB): Promise<boolean> {
    try {
        // Convert string inputs to BigInt for processing
        const transferData = convertToBigInt<TokenTransferData>(data, NUMERIC_FIELDS);

        // Get token info for proper decimal handling
        const token = await cache.findOnePromise('tokens', { symbol: data.symbol });
        if (!token) {
            logger.error(`[token-transfer] Token ${data.symbol} not found`);
            return false;
        }

        // Get sender's current balance
        const senderAccount = await cache.findOnePromise('accounts', { name: data.from });
        if (!senderAccount) {
            logger.error(`[token-transfer] Sender account ${data.from} not found`);
            return false;
        }

        // Convert balance string to BigInt with proper padding
        const senderBalance = convertToBigInt(senderAccount.balances?.[data.symbol] || '0', ['amount']);
        const newSenderBalance = senderBalance.amount - transferData.amount;

        // Deduct from sender with proper padding
        const deductSuccess = await cache.updateOnePromise(
            'accounts',
            { name: data.from },
            { $set: { [`balances.${data.symbol}`]: toString(newSenderBalance) } }
        );

        if (!deductSuccess) {
            logger.error(`[token-transfer] Failed to deduct from sender ${data.from}`);
            return false;
        }

        // Handle recipient balance update
        if (data.to !== BURN_ACCOUNT_NAME) {
            // Get recipient's current balance
            const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
            const recipientBalance = convertToBigInt(recipientAccount?.balances?.[data.symbol] || '0', ['amount']);
            const newRecipientBalance = recipientBalance.amount + transferData.amount;

            // Add to recipient with proper padding
            const addSuccess = await cache.updateOnePromise(
                'accounts',
                { name: data.to },
                { $set: { [`balances.${data.symbol}`]: toString(newRecipientBalance) } }
            );

            if (!addSuccess) {
                // Attempt to rollback sender deduction
                await cache.updateOnePromise(
                    'accounts',
                    { name: data.from },
                    { $set: { [`balances.${data.symbol}`]: toString(senderBalance.amount) } }
                );
                logger.error(`[token-transfer] Failed to add to recipient ${data.to}`);
                return false;
            }

            // Handle native token node approval adjustments
            if (data.symbol === config.nativeToken) {
                try {
                    await transaction.adjustNodeAppr(data.from, Number(newSenderBalance), () => {
                        logger.debug(`[token-transfer] Node approval adjusted for sender ${data.from}`);
                    });
                    await transaction.adjustNodeAppr(data.to, Number(newRecipientBalance), () => {
                        logger.debug(`[token-transfer] Node approval adjusted for recipient ${data.to}`);
                    });
                } catch (error) {
                    logger.error(`[token-transfer] Failed to adjust node approvals: ${error}`);
                    // Continue processing as this is not critical
                }
            }
        }

        // Log event with proper numeric formatting
        const eventDocument = {
            type: 'tokenTransfer',
            actor: sender,
            data: {
                symbol: data.symbol,
                from: data.from,
                to: data.to,
                amount: toString(transferData.amount),
                memo: data.memo
            }
        };

        await new Promise<void>((resolve) => {
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[token-transfer] Failed to log transfer event: ${err || 'no result'}`);
                }
                resolve();
            });
        });

        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error processing transfer: ${error}`);
        return false;
    }
} 