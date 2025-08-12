import logger from '../../logger.js';
import cache from '../../cache.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
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

export async function process(data: WitnessVoteData, sender: string, transactionId: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.error(`[witness-vote process] Sender account ${sender} not found for witness vote`);
      return false;
    }
    logger.trace(`[witness-vote process] Processing vote from: ${sender}`);
    logger.trace(`[witness-vote process] Sender account data before vote: ${JSON.stringify(senderAccount)}`);

    if (!senderAccount.votedWitnesses) {
      senderAccount.votedWitnesses = [];
    }
    const originalVotedWitnesses = [...senderAccount.votedWitnesses];
    
    const balanceStr = senderAccount.balances?.[config.nativeTokenSymbol] || toDbString(BigInt(0));
    logger.trace(`[witness-vote process] Sender ${sender} ${config.nativeTokenSymbol} balance BigInt: ${toBigInt(balanceStr).toString()}`);

    const oldSharePerWitnessBigInt = originalVotedWitnesses.length > 0 ? 
      toBigInt(balanceStr) / BigInt(originalVotedWitnesses.length) : BigInt(0);
    logger.trace(`[witness-vote process] Sender ${sender} oldSharePerWitnessBigInt: ${oldSharePerWitnessBigInt.toString()}`);

    const uniqueVotedWitnesses = new Set([...originalVotedWitnesses, data.target]);
    const newVotedWitnessesList = Array.from(uniqueVotedWitnesses);

    if (newVotedWitnessesList.length === originalVotedWitnesses.length && originalVotedWitnesses.includes(data.target)) {
      logger.warn(`[witness-vote process] Sender ${sender} attempted to vote for ${data.target} again, or validate() check failed. No change to votedWitnesses list.`);
      return true;
    }

    const newSharePerWitnessBigIntCalculated = newVotedWitnessesList.length > 0 ?
      toBigInt(balanceStr) / BigInt(newVotedWitnessesList.length) : BigInt(0);
    logger.trace(`[witness-vote process] Sender ${sender} newSharePerWitnessBigIntCalculated for target ${data.target}: ${newSharePerWitnessBigIntCalculated.toString()}`);

    try {
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnessesList } });
      logger.trace(`[witness-vote process] Sender ${sender} votedWitnesses list updated to: ${JSON.stringify(newVotedWitnessesList)}`);

      const adjustmentBigInt = newSharePerWitnessBigIntCalculated - oldSharePerWitnessBigInt;
      logger.trace(`[witness-vote process] Adjustment for original witnesses: ${adjustmentBigInt.toString()}`);

      for (const witnessName of originalVotedWitnesses) {
        if (adjustmentBigInt === BigInt(0)) continue;

        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
        if (witnessAccount) {
          logger.trace(`[witness-vote process] Adjusting original voter ${witnessName}: BEFORE ${JSON.stringify(witnessAccount)}`);
          const currentVoteWeight = witnessAccount.totalVoteWeight || toDbString(BigInt(0));
          let newTotalVoteWeightBigInt = toBigInt(currentVoteWeight) + adjustmentBigInt;
          if (newTotalVoteWeightBigInt < BigInt(0)) {
            newTotalVoteWeightBigInt = BigInt(0);
          }
          await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toDbString(newTotalVoteWeightBigInt) } });
          const witnessAccountAfter = await cache.findOnePromise('accounts', { name: witnessName });
          logger.trace(`[witness-vote process] Adjusting original voter ${witnessName}: AFTER ${JSON.stringify(witnessAccountAfter)}`);
        } else {
          logger.error(`[witness-vote process] Witness account ${witnessName} not found when trying to adjust totalVoteWeight.`);
          throw new Error(`Witness account ${witnessName} (previously voted by ${sender}) not found during vote weight adjustment for new vote on ${data.target}.`);
        }
      }
      
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      if (targetAccount) {
        logger.trace(`[witness-vote process] Updating target ${data.target}: BEFORE ${JSON.stringify(targetAccount)}`);
        const currentTargetVoteWeightStr = targetAccount.totalVoteWeight || toDbString(BigInt(0));
        logger.trace(`[witness-vote process] Target ${data.target} currentTotalVoteWeightStr: ${currentTargetVoteWeightStr}`);
        logger.trace(`[witness-vote process] Target ${data.target} currentTotalVoteWeightBigInt: ${toBigInt(currentTargetVoteWeightStr).toString()}`);
        
        const finalTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr) + newSharePerWitnessBigIntCalculated;
        logger.trace(`[witness-vote process] Target ${data.target} finalTargetVoteWeightBigInt (adding ${newSharePerWitnessBigIntCalculated.toString()}): ${finalTargetVoteWeightBigInt.toString()}`);
        
        await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toDbString(finalTargetVoteWeightBigInt) } });
        const targetAccountAfter = await cache.findOnePromise('accounts', { name: data.target });
        logger.trace(`[witness-vote process] Updating target ${data.target}: AFTER ${JSON.stringify(targetAccountAfter)}`);
      } else {
        logger.error(`[witness-vote process] Target account ${data.target} not found for final weight update.`);
        throw new Error(`Target account ${data.target} not found for final weight update.`);
      }

      // Log the successful vote event
      // event logging removed

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