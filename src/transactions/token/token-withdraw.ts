import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import chain from '../../chain.js';
import { TokenTransferData } from './token-interfaces.js';
import { toDbString, toBigInt, BigIntMath } from '../../utils/bigint.js';
import { steemBridge } from '../../modules/steemBridge.js';
import settings from '../../settings.js';
import { adjustBalance } from '../../utils/account.js';
const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

export async function validateTx(data: TokenTransferData, sender: string): Promise<boolean> {
    try {
        if (!data.symbol) {
            logger.warn('[token-transfer] Invalid data: Missing required fields symbol.');
            return false;
        }
        if (data.symbol !== settings.steemTokenSymbol && data.symbol !== settings.sbdTokenSymbol) {
            logger.warn(`[token-transfer] Non-Steem native token cannot be withdrawn.`);
            return false;
        }
        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token-transfer] Invalid token symbol format: ${data.symbol}.`);
            return false;
        }
        if (!validate.bigint(data.amount, false, false, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${toBigInt(data.amount).toString()}. Must be a positive integer.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[token-transfer] Sender account ${sender} not found.`);
            return false;
        }
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer] Token ${data.symbol} not found.`);
            return false;
        }
        const senderBalanceString = senderAccount.balances?.[data.symbol] || '0';
        const currentSenderBalance = toBigInt(senderBalanceString);
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

export async function process(data: TokenTransferData, sender: string, id: string): Promise<boolean> {
    try {
        const adjustedSender = await adjustBalance(sender, data.symbol, -toBigInt(data.amount));
        if (!adjustedSender) {
            logger.error(`[token-withdraw] Failed to debit sender ${sender} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }
        const adjustedRecipient = await adjustBalance(BURN_ACCOUNT_NAME, data.symbol, toBigInt(data.amount));
        if (!adjustedRecipient) {
            logger.error(`[token-withdraw] Failed to credit burn account ${BURN_ACCOUNT_NAME} for ${toBigInt(data.amount).toString()} ${data.symbol}`);
            return false;
        }
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        const decimals = typeof token?.precision === 'number' ? token.precision : parseInt(String(token?.precision || 0), 10);
        const formattedAmount = BigIntMath.formatWithDecimals(toBigInt(data.amount), isNaN(decimals) ? 8 : decimals);
        // Check if we should skip bridge operations (during replay)
        const currentBlock = chain.getLatestBlock();
        const currentBlockNum = currentBlock?._id || 0;
        if (settings.skipBridgeOperationsUntilBlock > 0 && currentBlockNum <= settings.skipBridgeOperationsUntilBlock) {
            logger.info(`[token-withdraw] Skipping Steem bridge operation during replay for block ${currentBlockNum} (skip until: ${settings.skipBridgeOperationsUntilBlock})`);
        } else {
            // Enqueue withdraw to process asynchronously off the block path
            await steemBridge.enqueueWithdraw(sender, formattedAmount, data.symbol, 'Withdraw from MeeRay');
        }
        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 