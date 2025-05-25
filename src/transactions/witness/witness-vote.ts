import logger from '../../logger.js';
import cache from '../../cache.js';
import { toBigInt, toString } from '../../utils/bigint-utils.js';
import config from '../../config.js';

export interface WitnessVoteData {
  target: string;
}

export async function validateTx(data: WitnessVoteData, sender: string): Promise<boolean> {
  try {
    // Check if target account exists
    const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
    if (!targetAccount) {
      logger.warn(`Invalid witness vote: target account ${data.target} not found`);
      return false;
    }

    // Check if sender account exists
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.warn(`Invalid witness vote: sender account ${sender} not found`);
      return false;
    }

    // Check if already voting for 30 witnesses
    if (senderAccount.votedWitnesses?.length >= config.maxWitnesses) {
      logger.warn(`Invalid witness vote: ${sender} already voting for ${senderAccount.votedWitnesses?.length} witnesses`);
      return false;
    }
    // Check if already voting for this witness
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
    // Get sender account
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.error(`Sender account ${sender} not found for witness vote`);
      return false;
    }
    // Initialize votedWitnesses array if it doesn't exist
    if (!senderAccount.votedWitnesses) {
      senderAccount.votedWitnesses = [];
    }
    // Witnesses before this vote
    const originalVotedWitnesses = [...senderAccount.votedWitnesses];
    const balance = senderAccount.tokens?.ECH || 0;

    // Calculate the vote share these original witnesses had
    const oldSharePerWitness = originalVotedWitnesses.length > 0 ?
      Math.floor(balance / originalVotedWitnesses.length) : 0;

    // Construct the new list of voted witnesses, ensuring uniqueness using a Set
    const uniqueVotedWitnesses = new Set([...originalVotedWitnesses, data.target]);
    const newVotedWitnessesList = Array.from(uniqueVotedWitnesses);

    // Check if the list actually changed.
    if (newVotedWitnessesList.length === originalVotedWitnesses.length && originalVotedWitnesses.includes(data.target)) {
      logger.warn(`[witness-vote process] Sender ${sender} attempted to vote for ${data.target} again, or validate() check failed. No change to votedWitnesses list.`);
      return true;
    }
    // Calculate the new vote share with the new target included
    const newSharePerWitness = newVotedWitnessesList.length > 0 ?
      Math.floor(balance / newVotedWitnessesList.length) : 0;
    try {
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnessesList } });

      const adjustment = BigInt(newSharePerWitness) - BigInt(oldSharePerWitness);

      for (const witnessName of originalVotedWitnesses) {
        if (adjustment === BigInt(0)) continue; // No change in share for this witness

        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
        if (witnessAccount) {
          const currentTotalVoteWeightStr = witnessAccount.totalVoteWeight || toString(BigInt(0));
          const currentTotalVoteWeightBigInt = toBigInt(currentTotalVoteWeightStr);

          let newTotalVoteWeightBigInt = currentTotalVoteWeightBigInt + adjustment;
          if (newTotalVoteWeightBigInt < BigInt(0)) {
            newTotalVoteWeightBigInt = BigInt(0); // Clamp at 0
          }
          await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toString(newTotalVoteWeightBigInt) } });
        } else {
          throw new Error(`Witness account ${witnessName} (previously voted by ${sender}) not found during vote weight adjustment for new vote on ${data.target}.`);
        }
      }
      logger.debug(`[witness-vote process] Updating target ${data.target} for sender ${sender}: balance=${balance}, list length=${newVotedWitnessesList.length}, sharePerWitness=${newSharePerWitness}`);

      // Update the newly voted witness (data.target)
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      if (targetAccount) {
        const currentTargetVoteWeightStr = targetAccount.totalVoteWeight || toString(BigInt(0));
        const currentTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr);
        const newSharePerWitnessBigInt = BigInt(newSharePerWitness);
        const finalTargetVoteWeightBigInt = currentTargetVoteWeightBigInt + newSharePerWitnessBigInt;
        // No need to clamp below zero here as newSharePerWitness should be positive
        await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toString(finalTargetVoteWeightBigInt) } });
      } else {
        throw new Error(`Target account ${data.target} not found for final weight update.`);
      }
      return true;
    } catch (updateError: any) {
      logger.error('Error updating accounts during witness vote:', updateError);
      // Attempt to rollback sender's votedWitnesses list
      try {
        await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: originalVotedWitnesses } });
        logger.warn(`Rolled back sender's votedWitnesses list for ${sender} due to update error.`);
        // Note: We do not attempt to rollback individual totalVoteWeight adjustments here.
      } catch (rollbackError: any) {
        logger.error("Failed to rollback sender's votedWitnesses list:", rollbackError);
      }
      return false;
    }
  } catch (error: any) {
    logger.error('Error processing witness vote:', error);
    return false;
  }
} 