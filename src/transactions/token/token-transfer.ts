import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import transaction from '../../transaction.js';
import { TokenTransferData, TokenTransferDataDB } from './token-interfaces.js';
import { convertToBigInt, convertToString, toString, getTokenDecimals, toBigInt } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';
const NUMERIC_FIELDS: Array<keyof TokenTransferData> = ['amount'];

export async function validateTx(data: TokenTransferDataDB, sender: string): Promise<boolean> {
    try {
        const transferData = convertToBigInt<TokenTransferData>(data, NUMERIC_FIELDS);
        if (!data.symbol || !data.to) {
            logger.warn('[token-transfer] Invalid data: Missing required fields (symbol, to).');
            return false;
        }
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer] Token ${data.symbol} not found.`);
            return false;
        }
        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token-transfer] Invalid token symbol format: ${data.symbol}.`);
            return false;
        }
        if (data.to !== BURN_ACCOUNT_NAME && !validate.string(data.to, 16, 3)) {
            logger.warn(`[token-transfer] Invalid recipient account name format: ${data.to}.`);
            return false;
        }
        
        const precision = typeof token.precision === 'number' ? token.precision : (typeof token.precision === 'string' ? parseInt(token.precision, 10) : 8);
        // Use a default of 30 for total digits if config.maxTokenAmountDigits is not set
        const totalDigits = (config as any).maxTokenAmountDigits || (30 - precision); 
        const maxAmountString = '9'.repeat(totalDigits) + '0'.repeat(precision);
        const maxAmount = BigInt(maxAmountString);

        if (!validate.bigint(transferData.amount, false, false, maxAmount, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${toString(transferData.amount)}. Must be a positive integer not exceeding ${toString(maxAmount)}.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[token-transfer] Sender account ${sender} not found.`);
            return false;
        }
        const senderBalanceString = senderAccount.balances?.[data.symbol] || '0';
        const currentSenderBalance = toBigInt(senderBalanceString);
        if (currentSenderBalance < transferData.amount) {
            logger.warn(`[token-transfer] Insufficient balance for ${sender}. Has: ${toString(currentSenderBalance)}, Needs: ${toString(transferData.amount)}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return false;
    }
}

export async function process(data: TokenTransferDataDB, sender: string, id: string): Promise<boolean> {
    try {
        const transferData = convertToBigInt<TokenTransferData>(data, NUMERIC_FIELDS);

        if (sender !== data.from) {
            logger.error(`[token-transfer:process] Transaction sender ${sender} does not match data.from ${data.from}. Aborting.`);
            return false;
        }

        const token = await cache.findOnePromise('tokens', { _id: transferData.symbol }); 
        if (!token) {
            logger.error(`[token-transfer] Token ${transferData.symbol} not found`);
            return false;
        }

        const senderAccount = await cache.findOnePromise('accounts', { name: sender }); 
        if (!senderAccount) {
            logger.error(`[token-transfer:process] Sender account ${sender} not found`);
            return false;
        }

        const senderBalanceString = senderAccount.balances?.[transferData.symbol] || '0';
        const currentSenderBalance = toBigInt(senderBalanceString);
        
        if (currentSenderBalance < transferData.amount) {
            logger.error(`[token-transfer:process] Insufficient balance for ${sender}. Has: ${toString(currentSenderBalance)}, Needs: ${toString(transferData.amount)}. Should have been caught by validateTx.`);
            return false;
        }
        const newSenderBalance = currentSenderBalance - transferData.amount;

        const deductSuccess = await cache.updateOnePromise(
            'accounts',
            { name: sender }, 
            { $set: { [`balances.${transferData.symbol}`]: toString(newSenderBalance) } }
        );

        if (!deductSuccess) {
            logger.error(`[token-transfer] Failed to deduct from sender ${sender}`);
            return false;
        }

        if (transferData.to !== BURN_ACCOUNT_NAME) {
            const recipientAccount = await cache.findOnePromise('accounts', { name: transferData.to });
            if (!recipientAccount) {
                logger.error(`[token-transfer:process] Recipient account ${transferData.to} not found. Rolling back sender deduction.`);
                 await cache.updateOnePromise(
                    'accounts',
                    { name: sender }, 
                    { $set: { [`balances.${transferData.symbol}`]: toString(currentSenderBalance) } } 
                );
                return false;
            }
            const recipientBalanceString = recipientAccount.balances?.[transferData.symbol] || '0';
            const currentRecipientBalance = toBigInt(recipientBalanceString);
            const newRecipientBalance = currentRecipientBalance + transferData.amount;

            const addSuccess = await cache.updateOnePromise(
                'accounts',
                { name: transferData.to },
                { $set: { [`balances.${transferData.symbol}`]: toString(newRecipientBalance) } }
            );

            if (!addSuccess) {
                await cache.updateOnePromise(
                    'accounts',
                    { name: sender }, 
                    { $set: { [`balances.${transferData.symbol}`]: toString(currentSenderBalance) } }
                );
                logger.error(`[token-transfer] Failed to add to recipient ${transferData.to}`);
                return false;
            }

            if (transferData.symbol === config.nativeToken) {
                try {
                    await transaction.adjustWitnessWeight(sender, Number(newSenderBalance), () => {
                        logger.debug(`[token-transfer] Witness weight adjusted for sender ${sender}`);
                    });
                    await transaction.adjustWitnessWeight(transferData.to, Number(newRecipientBalance), () => {
                        logger.debug(`[token-transfer] Witness weight adjusted for recipient ${transferData.to}`);
                    });
                } catch (error) {
                    logger.error(`[token-transfer] Failed to adjust witness weights: ${error}`);
                }
            }
        }

        const eventData = {
            symbol: transferData.symbol,
            from: sender, 
            to: transferData.to,
            amount: toString(transferData.amount),
            memo: transferData.memo
        };
        await logTransactionEvent('tokenTransfer', sender, eventData, id);

        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 