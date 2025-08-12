import logger from '../logger.js';
import cache from '../cache.js';
import { toDbString, toBigInt } from './bigint.js';

export interface Account {
    _id: string;
    balances: { [tokenIdentifier: string]: string };
}

export async function getAccount(accountId: string): Promise<Account | null> {
    return await cache.findOnePromise('accounts', { name: accountId }) as Account | null;
}

export async function adjustBalance(
    accountId: string,
    tokenIdentifier: string, 
    amount: bigint
): Promise<boolean> {
    try {
        const token = await cache.findOnePromise('tokens', { symbol: tokenIdentifier });
        if (!token) {
            logger.error(`[account-utils] Token ${tokenIdentifier} not found`);
            return false;
        }
        const precision = token.precision ?? 0;
        const account = await getAccount(accountId);
        if (!account) {
            logger.error(`[account-utils] Account ${accountId} not found`);
            return false;
        }
        const currentBalance = toBigInt(account.balances?.[tokenIdentifier] || '0');
        const newBalance = currentBalance + amount;

        if (newBalance < 0n) {
            logger.error(`[account-utils] Insufficient balance for ${accountId}: ${currentBalance} + ${amount} = ${newBalance}`);
            return false;
        }
        const updateResult = await cache.updateOnePromise(
            'accounts',
            { name: accountId },
            { $set: { [`balances.${tokenIdentifier}`]: toDbString(newBalance) } }
        );
        if (!updateResult) {
            logger.error(`[account-utils] Failed to update balance for ${accountId}`);
            return false;
        }
        logger.debug(`[account-utils] Updated balance for ${accountId}: ${tokenIdentifier} ${currentBalance} -> ${newBalance} (precision: ${precision})`);
        return true;
    } catch (error) {
        logger.error(`[account-utils] Error adjusting balance for ${accountId}: ${error}`);
        return false;
    }
}