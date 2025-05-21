import cache from '../cache.js';
import logger from '../logger.js';

export interface Account {
    name: string;
    balances: { [tokenIdentifier: string]: number };
}


export async function getAccount(name: string): Promise<Account | null> {
    logger.debug(`[account-utils] Fetching account: ${name}`);
    const account = await cache.findOnePromise('accounts', { name: name });
    if (account) {

        return account as Account; 
    }
    return null;
}

export async function adjustBalance(accountName: string, tokenIdentifier: string, amountDelta: number): Promise<boolean> {
    logger.debug(`[account-utils] Adjusting balance for ${accountName}, token ${tokenIdentifier}, delta ${amountDelta}`);
    
    const account = await getAccount(accountName);
    if (!account) {
        logger.warn(`[account-utils] Account ${accountName} not found for balance adjustment.`);
        return false;
    }

    const currentBalance = account.balances[tokenIdentifier] || 0;
    const newBalance = currentBalance + amountDelta;

    if (newBalance < 0) {
        logger.warn(`[account-utils] Insufficient balance for ${accountName} in token ${tokenIdentifier} to deduct ${Math.abs(amountDelta)}.`);
        return false;
    }

    // Update the balance
    // Note: This is a simplified non-atomic update.
    // TODO: Use cache.updateOnePromise with $set or $inc for the specific field.
    const updateSuccess = await cache.updateOnePromise(
        'accounts',
        { name: accountName },
        { $set: { [`balances.${tokenIdentifier}`]: newBalance } }
    );

    if (!updateSuccess) {
        logger.error(`[account-utils] Failed to update balance for ${accountName}, token ${tokenIdentifier}.`);
        return false;
    }

    logger.debug(`[account-utils] Balance updated for ${accountName}. Token: ${tokenIdentifier}, New Balance: ${newBalance}.`);
    return true;
} 