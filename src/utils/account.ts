import logger from '../logger.js';
import cache from '../cache.js';
import { toDbString, toBigInt } from './bigint.js';
import config from '../config.js';
import { witnessesModule } from '../witnesses.js';
import { Account } from "../mongo.js";


export async function getAccount(accountId: string): Promise<Account | null> {
    return await cache.findOnePromise('accounts', { name: accountId }) as Account | null;
}

export async function adjustBalance(
    accountId: string,
    tokenSymbol: string,
    amount: bigint
): Promise<boolean> {
    try {
        const account = await getAccount(accountId);
        const currentBalance = toBigInt(account!.balances?.[tokenSymbol] || '0');
        const newBalance = currentBalance + amount;

        if (newBalance < 0n) {
            logger.error(`[account-utils] Insufficient balance for ${accountId}: ${currentBalance} + ${amount} = ${newBalance}`);
            return false;
        }
        await cache.updateOnePromise(
            'accounts',
            { name: accountId },
            { $set: { [`balances.${tokenSymbol}`]: toDbString(newBalance) } }
        );
        // Adjust vote weights if native token changed
        if (tokenSymbol === config.nativeTokenSymbol && amount !== 0n) {
            const voterAccount = account || (await getAccount(accountId));
            const voted: string[] = (voterAccount as any)?.votedWitnesses || [];
            const numVoted = BigInt(voted.length || 0);
            if (numVoted > 0n) {
                const beforeSharePerWitness = currentBalance / numVoted;
                const afterSharePerWitness = newBalance / numVoted;
                const diffPerWitness = afterSharePerWitness - beforeSharePerWitness;
                if (diffPerWitness !== 0n) {
                    for (const witnessName of voted) {
                        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                        const currentVoteWeight = toBigInt(witnessAccount?.totalVoteWeight || toDbString(BigInt(0)));
                        let updated = currentVoteWeight + diffPerWitness;
                        if (updated < 0n) updated = 0n;
                        await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(updated) } });
                    }
                }
            }
        }
        logger.trace(`[account-utils] Updated balance for ${accountId}: ${tokenSymbol} ${currentBalance} -> ${newBalance}`);
        return true;
    } catch (error) {
        logger.error(`[account-utils] Error adjusting balance for ${accountId}: ${error}`);
        return false;
    }
}