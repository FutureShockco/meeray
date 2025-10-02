import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { steemBridge } from '../../modules/steemBridge.js';
import settings from '../../settings.js';
import { adjustUserBalance } from '../../utils/account.js';
import { BigIntMath, toBigInt } from '../../utils/bigint.js';
import { adjustTokenSupply } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { TokenData, TokenTransferData } from './token-interfaces.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (data.symbol !== settings.steemTokenSymbol && data.symbol !== settings.sbdTokenSymbol) {
            logger.warn(`[token-transfer] Non-Steem native token cannot be withdrawn.`);
            return { valid: false, error: 'non-steem token' };
        }

        if (!(await validate.tokenExists(data.symbol))) return { valid: false, error: 'token does not exist' };

        if (!(await validate.userBalances(sender, [{ symbol: data.symbol, amount: toBigInt(data.amount) }]))) return { valid: false, error: 'insufficient balance' };

        return { valid: true };
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: TokenTransferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const adjustedSender = await adjustUserBalance(sender, data.symbol, -toBigInt(data.amount));
        if (!adjustedSender) {
            logger.error(`[token-withdraw] Failed to debit sender ${sender} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return { valid: false, error: 'failed to debit sender' };
        }

        const adjustedRecipient = await adjustUserBalance(BURN_ACCOUNT_NAME, data.symbol, toBigInt(data.amount));
        if (!adjustedRecipient) {
            logger.error(`[token-withdraw] Failed to credit burn account ${BURN_ACCOUNT_NAME} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return { valid: false, error: 'failed to credit burn account' };
        }

        const token = (await cache.findOnePromise('tokens', { _id: data.symbol })) as TokenData | null;
        if (!token) {
            logger.error(`[token-withdraw] Token ${data.symbol} not found`);
            return { valid: false, error: 'token not found' };
        }

        const adjustedSupply = await adjustTokenSupply(data.symbol, -toBigInt(data.amount));
        if (!adjustedSupply) {
            logger.error(`[token-withdraw] Failed to adjust supply for ${data.symbol} when burning ${toBigInt(data.amount).toString()}.`);
            return { valid: false, error: 'failed to adjust supply' };
        }
        // Check if we should skip bridge operations (during replay)
        const currentBlock = chain.getLatestBlock();
        const currentBlockNum = currentBlock?._id || 0;

        if (settings.skipBridgeOperationsUntilBlock > 0 && currentBlockNum <= settings.skipBridgeOperationsUntilBlock) {
            logger.info(
                `[token-withdraw] Skipping Steem bridge operation during replay for block ${currentBlockNum} (skip until: ${settings.skipBridgeOperationsUntilBlock})`
            );
        } else {
            const formattedAmount = BigIntMath.formatWithDecimals(toBigInt(data.amount), isNaN(token.precision) ? 3 : token.precision);
            // Enqueue withdraw to process asynchronously off the block path
            await steemBridge.enqueueWithdraw(sender, formattedAmount, data.symbol, 'Withdraw from MeeRay');
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
