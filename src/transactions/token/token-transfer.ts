import logger from '../../logger.js';
import validate from '../../validation/index.js';
import { TokenTransferData } from './token-interfaces.js';
import { toDbString } from '../../utils/bigint.js';
import { adjustUserBalance } from '../../utils/account.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {

        if (!validate.tokenTransfer(sender, data.symbol, data.to, data.amount, data.memo, true)) return false;

        if (!validate.tokenExists(data.symbol)) return false;

        if (!await validate.userBalances(sender, [{ symbol: data.symbol, amount: BigInt(data.amount) }])) return false;

        return true;
    } catch (error) {
        logger.error(`[token-transfer:validation] Error validating transfer: ${error}`);
        return false;
    }
}

export async function processTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {

        const debitSender = await adjustUserBalance(sender, data.symbol, -BigInt(data.amount));
        if (!debitSender) {
            logger.error(`[token-transfer:process] Failed to debit sender ${sender} for ${BigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }

        const creditReceiver = await adjustUserBalance(data.to, data.symbol, BigInt(data.amount));
        if (!creditReceiver) {
            logger.error(`[token-transfer:process] Failed to credit recipient ${data.to} for ${BigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }

        await logEvent('token', 'transfer', sender, {
            symbol: data.symbol,
            from: sender,
            to: data.to,
            amount: toDbString(data.amount)
        });

        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
}