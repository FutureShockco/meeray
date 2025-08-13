import logger from '../../logger.js';
import cache from '../../cache.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import config from '../../config.js';

export interface WitnessVoteData {
  target: string;
}

export async function validateTx(data: WitnessVoteData, sender: string): Promise<boolean> {
  try {
    const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
    if (!targetAccount) {
      logger.warn(`Invalid witness vote: target account ${data.target} not found`);
      return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`Invalid witness vote: sender account ${sender} not found`);
      return false;
    }
    if (senderAccount.votedWitnesses?.length >= config.maxWitnesses) {
      logger.warn(`Invalid witness vote: ${sender} already voting for ${senderAccount.votedWitnesses?.length} witnesses`);
      return false;
    }
    if (senderAccount.votedWitnesses?.includes(data.target)) {
      logger.warn(`Invalid witness vote: ${sender} already voting for witness ${data.target}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error validating witness vote: ${error}`);
    return false;
  }
}

export async function process(data: WitnessVoteData, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    const originalVotedWitnesses = [...senderAccount!.votedWitnesses];
    const balanceStr = senderAccount!.balances?.[config.nativeTokenSymbol] || toDbString(BigInt(0));
    const oldSharePerWitnessBigInt = originalVotedWitnesses.length > 0 ?
      toBigInt(balanceStr) / BigInt(originalVotedWitnesses.length) : BigInt(0);

    const uniqueVotedWitnesses = new Set([...originalVotedWitnesses, data.target]);
    const newVotedWitnessesList = Array.from(uniqueVotedWitnesses);

    const newSharePerWitnessBigIntCalculated = newVotedWitnessesList.length > 0 ?
      toBigInt(balanceStr) / BigInt(newVotedWitnessesList.length) : BigInt(0);
    const previousWeights: Record<string, string> = {};
    for (const witnessName of new Set([...originalVotedWitnesses, data.target])) {
      const witnessAcc = await cache.findOnePromise('accounts', { name: witnessName });
      previousWeights[witnessName] = (witnessAcc?.totalVoteWeight as string) || toDbString(BigInt(0));
    }
    try {
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnessesList } });
      const adjustmentBigInt = newSharePerWitnessBigIntCalculated - oldSharePerWitnessBigInt;
      for (const witnessName of originalVotedWitnesses) {
        if (adjustmentBigInt === BigInt(0)) continue;
        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
        const currentVoteWeight = witnessAccount!.totalVoteWeight || toDbString(BigInt(0));
        let newTotalVoteWeightBigInt = toBigInt(currentVoteWeight) + adjustmentBigInt;
        if (newTotalVoteWeightBigInt < BigInt(0)) {
          newTotalVoteWeightBigInt = BigInt(0);
        }
        await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(newTotalVoteWeightBigInt) } });
      }
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      const currentTargetVoteWeightStr = targetAccount!.totalVoteWeight || toDbString(BigInt(0));
      const finalTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr) + newSharePerWitnessBigIntCalculated;
      await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toDbString(finalTargetVoteWeightBigInt) } });
      return true;
    } catch (updateError: any) {
      logger.error('Error updating accounts during witness vote:', updateError)
      return false;
    }
  } catch (error: any) {
    logger.error('Error processing witness vote:', error);
    return false;
  }
}