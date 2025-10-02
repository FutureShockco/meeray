import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { adjustTokenSupply } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { TokenTransferData } from './token-interfaces.js';

export async function validateTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!validate.tokenTransfer(sender, data.symbol, data.to, data.amount, data.memo, false)) return { valid: false, error: 'Invalid token transfer' };

        if (!validate.tokenExists(data.symbol)) return { valid: false, error: 'Token does not exist' };

        if (!(await validate.canMintToken(sender, data.symbol, data.amount))) return { valid: false, error: 'Insufficient minting rights' };

        return { valid: true };
    } catch (error) {
        logger.error(`[token-mint:validation] Error validating: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const adjustedBalance = await adjustUserBalance(data.to, data.symbol, toBigInt(data.amount));
        if (!adjustedBalance) {
            logger.error(`[token-mint:process] Failed to adjust balance for ${data.to} when minting ${toBigInt(data.amount).toString()} ${data.symbol}.`);
            return { valid: false, error: 'Failed to adjust balance' };
        }
        const adjustedSupply = await adjustTokenSupply(data.symbol, toBigInt(data.amount));
        if (adjustedSupply === null) {
            logger.error(`[token-mint:process] Failed to adjust supply for ${data.symbol} when minting ${toBigInt(data.amount).toString()}.`);
            return { valid: false, error: 'Failed to adjust supply' };
        }
        await logEvent('token', 'mint', sender, {
            symbol: data.symbol,
            to: data.to,
            amount: toDbString(data.amount),
            memo: data.memo,
            newSupply: toDbString(adjustedSupply),
        });
        return { valid: true };
    } catch (error) {
        logger.error(`[token-mint:process] Error: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
