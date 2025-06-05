import logger from '../../logger.js';
import cache from '../../cache.js';
import { toBigInt, toString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

export interface WitnessUnvoteData {
  target: string;
}

export async function validateTx(data: WitnessUnvoteData, sender: string): Promise<boolean> {
  try {
    // Check if target account exists
    const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
    if (!targetAccount) {
      logger.warn(`Invalid witness unvote: target account ${data.target} not found`);
      return false;
    }

    // Check if sender has voted for this witness
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
    // Get sender account
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.error(`Sender account ${sender} not found for witness unvote`);
      return false;
    }

    // Remove the vote
    const votedWitnesses = senderAccount.votedWitnesses || [];
    const newVotedWitnesses = votedWitnesses.filter((w: string) => w !== data.target);
    
    // Calculate vote weight changes
    const balanceStr = senderAccount.tokens?.ECH || toString(BigInt(0));
    const balanceBigInt = toBigInt(balanceStr);

    const newVoteWeightBigIntCalculated = newVotedWitnesses.length > 0 ? 
      balanceBigInt / BigInt(newVotedWitnesses.length) : BigInt(0);
    // oldVoteWeight should be based on the state BEFORE unvoting
    const oldVoteWeightBigIntCalculated = votedWitnesses.length > 0 ? 
      balanceBigInt / BigInt(votedWitnesses.length) : BigInt(0);

    try {
      // Update in sequence instead of using transactions
      
      // 1. Update sender account with new vote list
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnesses } });
      
      // 2. Update vote weights for remaining voted witnesses (their share increases)
      if (newVotedWitnesses.length > 0) {
        // This calculation is now BigInt based
        const adjustmentForRemainingBigInt = newVoteWeightBigIntCalculated - oldVoteWeightBigIntCalculated; 

        for (const witnessName of newVotedWitnesses) {
            const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
            if (witnessAccount) {
                const currentVoteWeightStr = witnessAccount.totalVoteWeight || toString(BigInt(0));
                const currentVoteWeightBigInt = toBigInt(currentVoteWeightStr);
                const newVoteWeightBigInt = currentVoteWeightBigInt + adjustmentForRemainingBigInt;
                await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: toString(newVoteWeightBigInt) } });
            } else {
                logger.error(`[witness-unvote] Witness account ${witnessName} not found when trying to adjust totalVoteWeight during share increase.`);
                // If a remaining witness isn't found, this could lead to inconsistent vote weights.
                // Consider throwing to trigger rollback.
                throw new Error(`Witness ${witnessName} not found for vote weight adjustment.`);
            }
        }
      }
      
      // 3. Remove votes from unvoted witness (data.target) - ensure totalVoteWeight doesn't go negative
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      if (targetAccount) {
        // Use the correctly calculated oldVoteWeightBigIntCalculated
        const currentTotalVoteWeightStr = targetAccount.totalVoteWeight || toString(BigInt(0));
        const currentTotalVoteWeightBigInt = toBigInt(currentTotalVoteWeightStr);
        
        let newTotalVoteWeightBigInt = currentTotalVoteWeightBigInt - oldVoteWeightBigIntCalculated;
        if (newTotalVoteWeightBigInt < BigInt(0)) {
            newTotalVoteWeightBigInt = BigInt(0); // Clamp at 0
        }
        await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: toString(newTotalVoteWeightBigInt) } });
      } else {
        logger.error(`[witness-unvote] Target account ${data.target} not found when trying to decrement totalVoteWeight.`);
        // Decide if this should throw or be part of a larger transaction rollback
        // Throwing an error here to ensure the catch block handles rollback
        throw new Error(`Target account ${data.target} not found for final weight update.`);
      }
      
      logger.debug(`Witness unvote from ${sender} to ${data.target} processed successfully`);
      
      // Log event for successful unvote
      const eventData = {
        unvoter: sender,
        targetWitness: data.target,
        remainingVotedWitnesses: newVotedWitnesses,
        newSharePerWitnessForUnvoter: toString(newVoteWeightBigIntCalculated) // Share for remaining votes by unvoter
      };
      await logTransactionEvent('witnessUnvote', sender, eventData, transactionId);
      
      return true;
    } catch (updateError: any) {
      logger.error('Error updating accounts during witness unvote:', updateError);
      
      // Try to rollback the sender account changes
      try {
        // Only attempt rollback if we managed to save the sender account
        const currentAccount = await cache.findOnePromise('accounts', { name: sender });
        if (currentAccount && !currentAccount.votedWitnesses?.includes(data.target)) {
          // If the target is no longer in the voted list, add it back
          const rolledBackVotedWitnesses = [...(currentAccount.votedWitnesses || []), data.target];
          await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: rolledBackVotedWitnesses } });
          logger.debug(`Rolled back witness unvote changes for ${sender}`);
        }
      } catch (rollbackError: any) {
        logger.error('Failed to rollback witness unvote changes:', rollbackError);
      }
      
      return false;
    }
  } catch (error: any) {
    logger.error('Error processing witness unvote:', error);
    return false;
  }
} 