import cache from '../cache.js';
import config from '../config.js';
import logger from '../logger.js';
import { Account } from '../mongo.js';
import { toBigInt, toDbString } from './bigint.js';

export async function getAccount(accountId: string): Promise<Account | null> {
    // Allow test hook to override account fetch
    if ((getAccount as any).__TEST_HOOK__) {
        return (getAccount as any).__TEST_HOOK__(accountId);
    }
    return (await cache.findOnePromise('accounts', { name: accountId })) as Account | null;
}

const adjustWitnessVoteWeights = async (account: Account | null, currentBalance: bigint, newBalance: bigint) => {
    const voterAccount = account;
    const voted: string[] = (voterAccount as any)?.votedWitnesses || [];
    const numVoted = toBigInt(voted.length || 0);
    if (numVoted > 0n) {
        const beforeSharePerWitness = currentBalance / numVoted;
        const afterSharePerWitness = newBalance / numVoted;
        const diffPerWitness = afterSharePerWitness - beforeSharePerWitness;
        if (diffPerWitness !== 0n) {
            for (const witnessName of voted) {
                const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                const currentVoteWeight = toBigInt(witnessAccount?.totalVoteWeight || 0);
                let updated = currentVoteWeight + diffPerWitness;
                if (updated < 0n) updated = 0n;
                await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(updated) } });
            }
        }
    }
};

export async function adjustUserBalance(accountId: string, tokenSymbol: string, amount: bigint | string): Promise<boolean> {
    try {
        // Allow test hook to override adjust behavior
        if ((adjustUserBalance as any).__TEST_HOOK__) {
            return (adjustUserBalance as any).__TEST_HOOK__(accountId, tokenSymbol, amount);
        }
        const account = await getAccount(accountId);
        const currentBalance = toBigInt(account!.balances?.[tokenSymbol] || '0');
        const newBalance = currentBalance + (typeof amount === 'string' ? toBigInt(amount) : amount);

        if (newBalance < 0n) {
            logger.error(`[account-utils] Insufficient balance for ${accountId}: ${currentBalance} + ${amount} = ${newBalance}`);
            return false;
        }
        await cache.updateOnePromise('accounts', { name: accountId }, { $set: { [`balances.${tokenSymbol}`]: toDbString(newBalance) } });
        // Adjust vote weights if native token changed
        if (tokenSymbol === config.nativeTokenSymbol && amount !== 0n) {
            adjustWitnessVoteWeights(account, currentBalance, newBalance);
        }
        logger.trace(`[account-utils] Updated balance for ${accountId}: ${tokenSymbol} ${currentBalance} -> ${newBalance}`);
        return true;
    } catch (error) {
        logger.error(`[account-utils] Error adjusting balance for ${accountId}: ${error}`);
        return false;
    }
}

// Test hook setter to inject mock implementations in unit tests without overwriting exports
export function __setTestHooks(hooks: {
    getAccount?: (accountId: string) => Promise<Account | null>;
    adjustUserBalance?: (accountId: string, tokenSymbol: string, amount: bigint | string) => Promise<boolean>;
}) {
    if (hooks.getAccount) (getAccount as any).__TEST_HOOK__ = hooks.getAccount;
    if (hooks.adjustUserBalance) (adjustUserBalance as any).__TEST_HOOK__ = hooks.adjustUserBalance;
}
