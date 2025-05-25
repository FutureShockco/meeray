import logger from '../logger.js';
import cache from '../cache.js';
import { BigIntMath, toString, toBigInt } from './bigint-utils.js';

export interface Account {
    _id: string;
    balances: { [tokenIdentifier: string]: string }; // Store as padded strings
    // ... other account fields
}

export async function getAccount(accountId: string): Promise<Account | null> {
    return await cache.findOnePromise('accounts', { _id: accountId }) as Account | null;
}

export async function adjustBalance(
    accountId: string, 
    tokenIdentifier: string, 
    amount: bigint
): Promise<boolean> {
    try {
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
            { _id: accountId },
            { $set: { [`balances.${tokenIdentifier}`]: toString(newBalance) } }
        );

        if (!updateResult) {
            logger.error(`[account-utils] Failed to update balance for ${accountId}`);
            return false;
        }

        logger.debug(`[account-utils] Updated balance for ${accountId}: ${tokenIdentifier} ${currentBalance} -> ${newBalance}`);
        return true;
    } catch (error) {
        logger.error(`[account-utils] Error adjusting balance for ${accountId}: ${error}`);
        return false;
    }
} 