import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';

export async function validateTx(data: { target: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (senderAccount?.votedWitnesses?.length >= config.maxWitnesses) {
            logger.warn(`Invalid witness vote: ${sender} already voting for ${senderAccount?.votedWitnesses?.length} witnesses`);
            return { valid: false, error: 'max witnesses reached' };
        }
        if (senderAccount?.votedWitnesses?.includes(data.target)) {
            logger.warn(`Invalid witness vote: ${sender} already voting for witness ${data.target}`);
            return { valid: false, error: 'already voting for target' };
        }
        return { valid: true };
    } catch (error) {
        logger.error(`Error validating witness vote: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: { target: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        const originalVotedWitnesses = [...senderAccount!.votedWitnesses];
        const balanceStr = senderAccount!.balances?.[config.nativeTokenSymbol] || toBigInt(0);
        const oldSharePerWitnessBigInt = originalVotedWitnesses.length > 0 ? toBigInt(balanceStr) / toBigInt(originalVotedWitnesses.length) : toBigInt(0);

        const uniqueVotedWitnesses = new Set([...originalVotedWitnesses, data.target]);
        const newVotedWitnessesList = Array.from(uniqueVotedWitnesses);

        const newSharePerWitnessBigIntCalculated =
            newVotedWitnessesList.length > 0 ? toBigInt(balanceStr) / toBigInt(newVotedWitnessesList.length) : toBigInt(0);

        try {
            await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnessesList } });
            const adjustmentBigInt = newSharePerWitnessBigIntCalculated - oldSharePerWitnessBigInt;
            for (const witnessName of originalVotedWitnesses) {
                if (adjustmentBigInt === toBigInt(0)) continue;
                const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                const currentVoteWeight = witnessAccount!.totalVoteWeight || toBigInt(0);
                let newTotalVoteWeightBigInt = toBigInt(currentVoteWeight) + adjustmentBigInt;
                if (newTotalVoteWeightBigInt < toBigInt(0)) {
                    newTotalVoteWeightBigInt = toBigInt(0);
                }
                await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(newTotalVoteWeightBigInt) } });
            }
            const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
            const currentTargetVoteWeightStr = targetAccount!.totalVoteWeight || toBigInt(0);
            const finalTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr) + newSharePerWitnessBigIntCalculated;
            await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toDbString(finalTargetVoteWeightBigInt) } });
            return { valid: true };
        } catch (updateError: any) {
            logger.error('Error updating accounts during witness vote:', updateError);
            return { valid: false, error: 'internal error' };
        }
    } catch (error: any) {
        logger.error('Error processing witness vote:', error);
        return { valid: false, error: 'internal error' };
    }
}
