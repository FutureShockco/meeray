import logger from '../../logger.js';
import validate from '../../validation/index.js';
import { TokenTransferData } from './token-interfaces.js';
import { toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { adjustTokenSupply } from '../../utils/token.js';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        if (!validate.tokenTransfer(sender, data.symbol, data.to, data.amount, data.memo, false)) return false;

        if (!validate.tokenExists(data.symbol)) return false;

        if (!await validate.canMintToken(sender, data.symbol, data.amount)) return false;

        return true;
    } catch (error) {
        logger.error(`[token-mint:validation] Error validating: ${error}`);
        return false;
    }
}

export async function processTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        const adjustedBalance = await adjustUserBalance(data.to, data.symbol, BigInt(data.amount));
        if (!adjustedBalance) {
            logger.error(`[token-mint:process] Failed to adjust balance for ${data.to} when minting ${BigInt(data.amount).toString()} ${data.symbol}.`);
            return false;
        }
        const adjustedSupply = await adjustTokenSupply(data.symbol, BigInt(data.amount));
        if (adjustedSupply === null) {
            logger.error(`[token-mint:process] Failed to adjust supply for ${data.symbol} when minting ${BigInt(data.amount).toString()}.`);
            return false;
        }
        await logEvent('token', 'mint', sender, {
            symbol: data.symbol,
            to: data.to,
            amount: toDbString(data.amount),
            memo: data.memo,
            newSupply: toDbString(adjustedSupply)
        });
        return true;
    } catch (error) {
        logger.error(`[token-mint:process] Error: ${error}`);
        return false;
    }
} 