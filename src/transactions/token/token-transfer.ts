import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { TokenTransferData } from './token-interfaces.js';
import { toBigInt } from '../../utils/bigint.js';
import { adjustBalance } from '../../utils/account.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        if (!data.symbol || !data.to) {
            logger.warn('[token-transfer] Invalid data: Missing required fields (symbol, to).');
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
        if (!validate.bigint(data.amount, false, false, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${toBigInt(data.amount).toString()}. Must be a positive integer.`);
            return false;
        }
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer] Token ${data.symbol} not found.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        const currentSenderBalance = toBigInt(senderAccount?.balances?.[data.symbol] || '0');
        if (currentSenderBalance < toBigInt(data.amount)) {
            logger.warn(`[token-transfer] Insufficient balance for ${sender}. Has: ${currentSenderBalance.toString()}, Needs: ${toBigInt(data.amount).toString()}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return false;
    }
}

export async function process(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        const debitOk = await adjustBalance(sender, data.symbol, -toBigInt(data.amount));
        if (!debitOk) return false;
        const creditOk = await adjustBalance(data.to, data.symbol, toBigInt(data.amount));
        if (!creditOk) return false;
        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 