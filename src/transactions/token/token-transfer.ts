import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { TokenTransferData } from './token-interfaces.js';

export async function validateTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!validate.tokenTransfer(sender, data.symbol, data.to, data.amount, data.memo, true)) return { valid: false, error: 'Invalid token transfer' };

        if (!validate.tokenExists(data.symbol)) return { valid: false, error: 'Token does not exist' };

        if (!(await validate.userBalances(sender, [{ symbol: data.symbol, amount: toBigInt(data.amount) }]))) return { valid: false, error: 'Insufficient balance' };

        return { valid: true };
    } catch (error) {
        logger.error(`[token-transfer:validation] Error validating transfer: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const debitSender = await adjustUserBalance(sender, data.symbol, -toBigInt(data.amount));
        if (!debitSender) {
            logger.error(`[token-transfer:process] Failed to debit sender ${sender} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return { valid: false, error: 'Failed to debit sender' };
        }

        const creditReceiver = await adjustUserBalance(data.to, data.symbol, toBigInt(data.amount));
        if (!creditReceiver) {
            logger.error(`[token-transfer:process] Failed to credit recipient ${data.to} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return { valid: false, error: 'Failed to credit recipient' };
        }

        await logEvent('token', 'transfer', sender, {
            symbol: data.symbol,
            from: sender,
            to: data.to,
            amount: toDbString(data.amount),
        });

        return { valid: true };
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
