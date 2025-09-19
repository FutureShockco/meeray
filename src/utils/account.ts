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
        // Adjust vote weights if native token changed, matching original share-diff logic
        if (tokenSymbol === config.nativeTokenSymbol && BigInt(newBalance) > 0) {
            const adjustedWitnessWeight = await witnessesModule.updateWitnessVoteWeights({ sender: accountId, targetWitness: undefined, isVote: false, isUnvote: false });
            if (!adjustedWitnessWeight) {
                logger.error(`[account-utils] Failed to adjust witness weights for ${accountId} after balance change of ${amount}`);
                return false;
            }
        }
        logger.trace(`[account-utils] Updated balance for ${accountId}: ${tokenSymbol} ${currentBalance} -> ${newBalance}`);
        return true;
    } catch (error) {
        logger.error(`[account-utils] Error adjusting balance for ${accountId}: ${error}`);
        return false;
    }
}