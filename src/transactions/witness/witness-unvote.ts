import logger from '../../logger.js';
import cache from '../../cache.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import config from '../../config.js';

export interface WitnessUnvoteData {
  target: string;
}

export async function validateTx(data: WitnessUnvoteData, sender: string): Promise<boolean> {
  try {
    const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
    if (!targetAccount) {
      logger.warn(`Invalid witness unvote: target account ${data.target} not found`);
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`Invalid witness unvote: sender account ${sender} not found`);
      return false;
    }
    if (!senderAccount.votedWitnesses?.includes(data.target)) {
      logger.warn(`Invalid witness unvote: ${sender} has not voted for ${data.target}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error validating witness unvote: ${error}`);
    return false;
  }
}

export async function process(data: WitnessUnvoteData, sender: string, transactionId: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    const votedWitnesses = senderAccount!.votedWitnesses || [];
    const newVotedWitnesses = votedWitnesses.filter((w: string) => w !== data.target);
    const balanceStr = senderAccount!.balances?.[config.nativeTokenSymbol] || toDbString(BigInt(0));
    const newVoteWeightBigIntCalculated = newVotedWitnesses.length > 0 ?
      toBigInt(balanceStr) / BigInt(newVotedWitnesses.length) : BigInt(0);
    const oldVoteWeightBigIntCalculated = votedWitnesses.length > 0 ?
      toBigInt(balanceStr) / BigInt(votedWitnesses.length) : BigInt(0);

    try {
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnesses } });
      if (newVotedWitnesses.length > 0) {
        const adjustmentForRemainingBigInt = newVoteWeightBigIntCalculated - oldVoteWeightBigIntCalculated;

        for (const witnessName of newVotedWitnesses) {
          const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
          if (witnessAccount) {
            const currentVoteWeightStr = witnessAccount.totalVoteWeight || toDbString(BigInt(0));
            const newVoteWeightBigInt = toBigInt(currentVoteWeightStr) + adjustmentForRemainingBigInt;
            await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(newVoteWeightBigInt) } });
          } else {
            logger.error(`[witness-unvote] Witness account ${witnessName} not found when trying to adjust totalVoteWeight during share increase.`);
            throw new Error(`Witness ${witnessName} not found for vote weight adjustment.`);
          }
        }
      }
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      const currentTotalVoteWeightStr = targetAccount!.totalVoteWeight || toDbString(BigInt(0));
      let newTotalVoteWeightBigInt = toBigInt(currentTotalVoteWeightStr) - oldVoteWeightBigIntCalculated;
      if (newTotalVoteWeightBigInt < BigInt(0)) {
        newTotalVoteWeightBigInt = BigInt(0);
      }
      await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toDbString(newTotalVoteWeightBigInt) } });
      logger.debug(`Witness unvote from ${sender} to ${data.target} processed successfully`);
      return true;
    } catch (updateError: any) {
      logger.error('Error updating accounts during witness unvote:', updateError);
      return false;
    }
  } catch (error: any) {
    logger.error('Error processing witness unvote:', error);
    return false;
  }
} 