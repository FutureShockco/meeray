import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import transaction from '../../transaction.js';
import { TokenTransferData } from './token-interfaces.js';
import { toString, getTokenDecimals, toBigInt } from '../../utils/bigint.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
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
        if (data.to === sender) {
            logger.warn(`[token-transfer] Sender and recipient cannot be the same: ${data.to}.`);
            return false;
        }

        const precision = typeof token.precision === 'number' ? token.precision : (typeof token.precision === 'string' ? parseInt(token.precision, 10) : 8);
        // Use a default of 30 for total digits if config.maxTokenAmountDigits is not set
        const totalDigits = config.maxTokenAmountDigits || (30 - precision);
        const maxAmountString = '9'.repeat(totalDigits) + '0'.repeat(precision);
        const maxAmount = BigInt(maxAmountString);

        if (!validate.bigint(data.amount, false, false, maxAmount, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${toString(data.amount)}. Must be a positive integer not exceeding ${toString(maxAmount)}.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[token-transfer] Sender account ${sender} not found.`);
            return false;
        }
        const senderBalanceString = senderAccount.balances?.[data.symbol] || '0';
        const currentSenderBalance = toBigInt(senderBalanceString);
        if (currentSenderBalance < data.amount) {
            logger.warn(`[token-transfer] Insufficient balance for ${sender}. Has: ${toString(currentSenderBalance)}, Needs: ${toString(data.amount)}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return false;
    }
}

export async function process(data: TokenTransferData, sender: string, id: string): Promise<boolean> {
    try {

        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.error(`[token-transfer] Token ${data.symbol} not found`);
            return false;
        }

        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.error(`[token-transfer:process] Sender account ${sender} not found`);
            return false;
        }

        const senderBalanceString = senderAccount.balances?.[data.symbol] || '0';
        const currentSenderBalance = toBigInt(senderBalanceString);

        if (currentSenderBalance < data.amount) {
            logger.error(`[token-transfer:process] Insufficient balance for ${sender}. Has: ${toString(currentSenderBalance)}, Needs: ${toString(data.amount)}. Should have been caught by validateTx.`);
            return false;
        }
        const newSenderBalance = currentSenderBalance - data.amount;

        const deductSuccess = await cache.updateOnePromise(
            'accounts',
            { name: sender },
            { $set: { [`balances.${data.symbol}`]: toString(newSenderBalance) } }
        );

        if (!deductSuccess) {
            logger.error(`[token-transfer] Failed to deduct from sender ${sender}`);
            return false;
        }

        if (data.to !== BURN_ACCOUNT_NAME) {
            const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
            if (!recipientAccount) {
                logger.error(`[token-transfer:process] Recipient account ${data.to} not found. Rolling back sender deduction.`);
                await cache.updateOnePromise(
                    'accounts',
                    { name: sender },
                    { $set: { [`balances.${data.symbol}`]: toString(currentSenderBalance) } }
                );
                return false;
            }
            const recipientBalanceString = recipientAccount.balances?.[data.symbol] || '0';
            const currentRecipientBalance = toBigInt(recipientBalanceString);
            const newRecipientBalance = currentRecipientBalance + data.amount;

            const addSuccess = await cache.updateOnePromise(
                'accounts',
                { name: data.to },
                { $set: { [`balances.${data.symbol}`]: toString(newRecipientBalance) } }
            );

            if (!addSuccess) {
                await cache.updateOnePromise(
                    'accounts',
                    { name: sender },
                    { $set: { [`balances.${data.symbol}`]: toString(currentSenderBalance) } }
                );
                logger.error(`[token-transfer] Failed to add to recipient ${data.to}`);
                return false;
            }

            if (data.symbol === config.nativeToken) {
                try {
                    await transaction.adjustWitnessWeight(sender, Number(newSenderBalance), () => {
                        logger.debug(`[token-transfer] Witness weight adjusted for sender ${sender}`);
                    });
                    await transaction.adjustWitnessWeight(data.to, Number(newRecipientBalance), () => {
                        logger.debug(`[token-transfer] Witness weight adjusted for recipient ${data.to}`);
                    });
                } catch (error) {
                    logger.error(`[token-transfer] Failed to adjust witness weights: ${error}`);
                }
            }
        }


        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 