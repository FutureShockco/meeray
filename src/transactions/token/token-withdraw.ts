import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import chain from '../../chain.js';
import { TokenData, TokenTransferData } from './token-interfaces.js';
import { BigIntMath } from '../../utils/bigint.js';
import { steemBridge } from '../../modules/steemBridge.js';
import settings from '../../settings.js';
import { adjustUserBalance } from '../../utils/account.js';
import { adjustTokenSupply } from '../../utils/token.js';
const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        if (data.symbol !== settings.steemTokenSymbol && data.symbol !== settings.sbdTokenSymbol) {
            logger.warn(`[token-transfer] Non-Steem native token cannot be withdrawn.`);
            return false;
        }

        if (!await validate.tokenExists(data.symbol)) return false;

        if (!await validate.userBalances(sender, [{ symbol: data.symbol, amount: BigInt(data.amount) }])) return false;

        return true;
    } catch (error) {
        logger.error(`[token-transfer] Error validating transfer: ${error}`);
        return false;
    }
}

export async function processTx(data: TokenTransferData, sender: string, id: string): Promise<boolean> {
    try {
        const adjustedSender = await adjustUserBalance(sender, data.symbol, -BigInt(data.amount));
        if (!adjustedSender) {
            logger.error(`[token-withdraw] Failed to debit sender ${sender} for ${BigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }

        const adjustedRecipient = await adjustUserBalance(BURN_ACCOUNT_NAME, data.symbol, BigInt(data.amount));
        if (!adjustedRecipient) {
            logger.error(`[token-withdraw] Failed to credit burn account ${BURN_ACCOUNT_NAME} for ${BigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }

        const token = await cache.findOnePromise('tokens', { _id: data.symbol }) as TokenData | null;
        if (!token) {
            logger.error(`[token-withdraw] Token ${data.symbol} not found`);
            return false;
        }

        const adjustedSupply = await adjustTokenSupply(data.symbol, -BigInt(data.amount));
        if (!adjustedSupply) {
            logger.error(`[token-withdraw] Failed to adjust supply for ${data.symbol} when burning ${BigInt(data.amount).toString()}.`);
            return false;
        }
        // Check if we should skip bridge operations (during replay)
        const currentBlock = chain.getLatestBlock();
        const currentBlockNum = currentBlock?._id || 0;

        if (settings.skipBridgeOperationsUntilBlock > 0 && currentBlockNum <= settings.skipBridgeOperationsUntilBlock) {
            logger.info(`[token-withdraw] Skipping Steem bridge operation during replay for block ${currentBlockNum} (skip until: ${settings.skipBridgeOperationsUntilBlock})`);
        } else {
            const formattedAmount = BigIntMath.formatWithDecimals(BigInt(data.amount), isNaN(token.precision) ? 3 : token.precision);
            // Enqueue withdraw to process asynchronously off the block path
            await steemBridge.enqueueWithdraw(sender, formattedAmount, data.symbol, 'Withdraw from MeeRay');
        }

        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
}