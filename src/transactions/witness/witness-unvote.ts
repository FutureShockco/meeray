import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';

export async function validateTx(data: { target: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount?.votedWitnesses?.includes(data.target)) {
            logger.warn(`[witness-unvote:validation] Invalid witness unvote: ${sender} has not voted for ${data.target}`);
            return { valid: false, error: 'not voted for target' };
        }
        return { valid: true };
    } catch (error) {
        logger.error(`[witness-unvote:validation] Error validating witness unvote: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: { target: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        const votedWitnesses = senderAccount!.votedWitnesses || [];
        const newVotedWitnesses = votedWitnesses.filter((w: string) => w !== data.target);
        const balanceStr = senderAccount!.balances?.[config.nativeTokenSymbol] || toBigInt(0);
        const newVoteWeightBigIntCalculated = newVotedWitnesses.length > 0 ? toBigInt(balanceStr) / toBigInt(newVotedWitnesses.length) : toBigInt(0);
        const oldVoteWeightBigIntCalculated = votedWitnesses.length > 0 ? toBigInt(balanceStr) / toBigInt(votedWitnesses.length) : toBigInt(0);

        try {
            await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnesses } });
            if (newVotedWitnesses.length > 0) {
                const adjustmentForRemainingBigInt = newVoteWeightBigIntCalculated - oldVoteWeightBigIntCalculated;

                for (const witnessName of newVotedWitnesses) {
                    const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                    if (witnessAccount) {
                        const currentVoteWeightStr = witnessAccount.totalVoteWeight || toBigInt(0);
                        const newVoteWeightBigInt = toBigInt(currentVoteWeightStr) + adjustmentForRemainingBigInt;
                        await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(newVoteWeightBigInt) } });
                    } else {
                        logger.error(`[witness-unvote] Witness account ${witnessName} not found when trying to adjust totalVoteWeight during share increase.`);
                    }
                }
            }
            const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
            const currentTotalVoteWeightStr = targetAccount!.totalVoteWeight || toBigInt(0);
            let newTotalVoteWeightBigInt = toBigInt(currentTotalVoteWeightStr) - oldVoteWeightBigIntCalculated;
            if (newTotalVoteWeightBigInt < toBigInt(0)) {
                newTotalVoteWeightBigInt = toBigInt(0);
            }
            await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toDbString(newTotalVoteWeightBigInt) } });
            logger.debug(`Witness unvote from ${sender} to ${data.target} processed successfully`);
            return { valid: true };
        } catch (updateError: any) {
            logger.error('Error updating accounts during witness unvote:', updateError);
            return { valid: false, error: 'internal error' };
        }
    } catch (error: any) {
        logger.error('Error processing witness unvote:', error);
        return { valid: false, error: 'internal error' };
    }
}
