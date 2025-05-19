import cache from '../cache.js';
import logger from '../logger.js';

// Placeholder for Account type from your system
export interface Account {
    name: string;
    balances: { [tokenIdentifier: string]: number };
    // other account fields
}

/**
 * Placeholder for fetching an account from the cache.
 */
export async function getAccount(name: string): Promise<Account | null> {
    logger.debug(`[account-utils] Fetching account: ${name}`);
    const account = await cache.findOnePromise('accounts', { name: name });
    if (account) {
        // Assuming the structure matches the Account interface
        // You might need to map fields if the cache structure is different
        return account as Account; 
    }
    return null;
}

/**
 * Placeholder for adjusting a token balance for an account.
 * This should handle token existence and ensure atomicity in a real system.
 */
export async function adjustBalance(accountName: string, tokenIdentifier: string, amountDelta: number): Promise<boolean> {
    logger.debug(`[account-utils] Adjusting balance for ${accountName}, token ${tokenIdentifier}, delta ${amountDelta}`);
    
    const account = await getAccount(accountName);
    if (!account) {
        logger.warn(`[account-utils] Account ${accountName} not found for balance adjustment.`);
        return false;
    }

    // In a real system, you'd likely use $inc for atomic updates directly in the database query
    const currentBalance = account.balances[tokenIdentifier] || 0;
    const newBalance = currentBalance + amountDelta;

    if (newBalance < 0) {
        logger.warn(`[account-utils] Insufficient balance for ${accountName} in token ${tokenIdentifier} to deduct ${Math.abs(amountDelta)}.`);
        return false;
    }

    // Update the balance
    // Note: This is a simplified non-atomic update for placeholder purposes.
    // In a real implementation, use cache.updateOnePromise with $set or $inc for the specific field.
    const updateSuccess = await cache.updateOnePromise(
        'accounts',
        { name: accountName },
        { $set: { [`balances.${tokenIdentifier}`]: newBalance } }
    );

    if (!updateSuccess) {
        logger.error(`[account-utils] Failed to update balance for ${accountName}, token ${tokenIdentifier}.`);
        return false;
    }

    logger.info(`[account-utils] Balance updated for ${accountName}. Token: ${tokenIdentifier}, New Balance: ${newBalance}.`);
    return true;
} 