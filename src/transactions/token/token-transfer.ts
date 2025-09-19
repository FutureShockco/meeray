import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { TokenTransferData } from './token-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { adjustBalance } from '../../utils/account.js';
import { logEvent } from '../../utils/event-logger.js';
import { witnessesModule } from '../../witnesses.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        if (!data.symbol || !data.to) {
            logger.warn('[token-transfer:validation] Invalid data: Missing required fields (symbol, to).');
            return false;
        }
        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token-transfer:validation] Invalid token symbol format: ${data.symbol}.`);
            return false;
        }
        if (data.to !== BURN_ACCOUNT_NAME && !validate.string(data.to, 16, 3)) {
            logger.warn(`[token-transfer:validation] Invalid recipient account name format: ${data.to}.`);
            return false;
        }
        if (data.to === sender) {
            logger.warn(`[token-transfer:validation] Sender and recipient cannot be the same: ${sender}>${data.to}.`);
            return false;
        }
        if (data.memo !== undefined && !validate.string(data.memo, 512, 0)) {
            logger.warn(`[token-transfer:validation] Memo can not be longer than 512 it is ${data.memo.length}.`);
            return false;
        }
        if (!validate.bigint(data.amount, false, false, BigInt(1))) {
            logger.warn(`[token-transfer:validation] Invalid amount: ${toBigInt(data.amount).toString()}. Must be a positive integer.`);
            return false;
        }
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer:validation] Token ${data.symbol} not found.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        const currentSenderBalance = toBigInt(senderAccount?.balances?.[data.symbol] || '0');
        if (currentSenderBalance < toBigInt(data.amount)) {
            logger.warn(`[token-transfer:validation] Insufficient balance for ${sender}. Has: ${currentSenderBalance.toString()}, Needs: ${toBigInt(data.amount).toString()}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`[token-transfer:validation] Error validating transfer: ${error}`);
        return false;
    }
}

export async function process(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        const debitSender = await adjustBalance(sender, data.symbol, -toBigInt(data.amount));
        if (!debitSender) {
            logger.error(`[token-transfer:process] Failed to debit sender ${sender} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }
        const creditReceiver = await adjustBalance(data.to, data.symbol, toBigInt(data.amount));
        if (!creditReceiver) {
            logger.error(`[token-transfer:process] Failed to credit recipient ${data.to} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }

        await logEvent('token', 'transfer', sender, {
            symbol: data.symbol,
            from: sender,
            to: data.to,
            amount: toDbString(toBigInt(data.amount))
        });
        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 