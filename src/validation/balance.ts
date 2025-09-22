import logger from '../logger.js';
import { getAccount } from '../utils/account.js';
import validate from './index.js';
/**
 * Validates that the user has sufficient balances for one or more tokens.
 * @param user User account name
 * @param requirements Array of { symbol, amount } objects
 * @returns True if all balances are sufficient, false otherwise
 */
export const userBalances = async (
    user: string,
    requirements: Array<{ symbol: string; amount: string | bigint }>
): Promise<boolean> => {
    const userAccount = await getAccount(user);
    if (!userAccount) {
        logger.warn(`[balance-validation] User account ${user} not found.`);
        return false;
    }

    for (const req of requirements) {
        const balance = BigInt(userAccount.balances[req.symbol] || 0);
        if (!balance) {
            logger.warn(`[balance-validation] User account ${user} has no balance for token ${req.symbol}.`);
            return false;
        }
        if (!validate.bigint(req.amount, false, false, BigInt(1))) {
            logger.warn(`[token-transfer] Invalid amount: ${BigInt(req.amount).toString()}. Must be a positive integer.`);
            return false;
        }
        if (balance < BigInt(req.amount)) {
            logger.warn(`[balance-validation] Insufficient balance for ${req.symbol}. Required: ${req.amount}, Available: ${balance}`);
            return false;
        }
    }
    return true;
};

export default userBalances;