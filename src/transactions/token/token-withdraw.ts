import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import transaction from '../../transaction.js';
import { TokenTransferData } from './token-interfaces.js';
import { toDbString, toBigInt, BigIntMath } from '../../utils/bigint.js';
import steemBridge from '../../modules/steemBridge.js';
import settings from '../../settings.js';
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
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.warn(`[token-transfer] Token ${data.symbol} not found.`);
            return false;
        }
        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token-transfer] Invalid token symbol format: ${data.symbol}.`);
            return false;
        }

        if (!validate.bigint(data.amount, false, false, undefined, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${toBigInt(data.amount).toString()}. Must be a positive integer.`);
            return false;
        }
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[token-transfer] Sender account ${sender} not found.`);
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
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        const senderBalance = toBigInt(senderAccount!.balances?.[data.symbol] || '0');
        const newSenderBalance = senderBalance - toBigInt(data.amount);

        await cache.updateOnePromise(
            'accounts',
            { name: sender },
            { $set: { [`balances.${data.symbol}`]: toDbString(newSenderBalance) } }
        );

        const recipientAccount = await cache.findOnePromise('accounts', { name: BURN_ACCOUNT_NAME });
        const newRecipientBalance = toBigInt(recipientAccount!.balances?.[data.symbol] || '0') + toBigInt(data.amount);

        await cache.updateOnePromise(
            'accounts',
            { name: BURN_ACCOUNT_NAME },
            { $set: { [`balances.${data.symbol}`]: toDbString(newRecipientBalance) } }
        );

        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        const decimals = typeof token?.precision === 'number' ? token.precision : parseInt(String(token?.precision || 0), 10);
        const formattedAmount = BigIntMath.formatWithDecimals(toBigInt(data.amount), isNaN(decimals) ? 8 : decimals);
        await steemBridge.transfer(sender, formattedAmount, data.symbol, 'Withdraw from Echelon');

        return true;
    } catch (error) {
        logger.error(`[token-transfer:process] Error processing transfer: ${error}`);
        return false;
    }
} 