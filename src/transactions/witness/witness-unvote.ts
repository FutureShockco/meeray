import logger from '../../logger.js';
import cache from '../../cache.js';

export interface WitnessUnvoteData {
  target: string;
}

export async function validate(data: WitnessUnvoteData, sender: string): Promise<boolean> {
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

export async function process(data: WitnessUnvoteData, sender: string): Promise<boolean> {
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
    const balance = senderAccount.tokens?.ECH || 0;
    const newVoteWeight = newVotedWitnesses.length > 0 ? 
      Math.floor(balance / newVotedWitnesses.length) : 0;
    const oldVoteWeight = votedWitnesses.length > 0 ? 
      Math.floor(balance / votedWitnesses.length) : 0;

    try {
      // Update in sequence instead of using transactions
      
      // 1. Update sender account with new vote list
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnesses } });
      
      // 2. Update vote weights for remaining voted witnesses (their share increases)
      if (newVotedWitnesses.length > 0) {
        const adjustmentForRemaining = newVoteWeight - oldVoteWeight; // This will be positive
        for (const witnessName of newVotedWitnesses) {
            await cache.updateOnePromise('accounts', { name: witnessName }, { $inc: { totalVoteWeight: adjustmentForRemaining } });
        }
      }
      
      // 3. Remove votes from unvoted witness (data.target) - ensure totalVoteWeight doesn't go negative
      const targetAccount = await cache.findOnePromise('accounts', { name: data.target });
      if (targetAccount) {
        const currentTotalVoteWeight = targetAccount.totalVoteWeight || 0;
        const finalTotalVoteWeight = Math.max(0, currentTotalVoteWeight - oldVoteWeight);
        await cache.updateOnePromise('accounts', { name: data.target }, { $set: { totalVoteWeight: finalTotalVoteWeight } });
      } else {
        logger.error(`[witness-unvote] Target account ${data.target} not found when trying to decrement totalVoteWeight.`);
        // Decide if this should throw or be part of a larger transaction rollback
      }
      
      logger.info(`Witness unvote from ${sender} to ${data.target} processed successfully`);
      return true;
    } catch (updateError) {
      logger.error(`Error updating accounts during witness unvote: ${updateError}`);
      
      // Try to rollback the sender account changes
      try {
        // Only attempt rollback if we managed to save the sender account
        const currentAccount = await cache.findOnePromise('accounts', { name: sender });
        if (currentAccount && !currentAccount.votedWitnesses?.includes(data.target)) {
          // If the target is no longer in the voted list, add it back
          const rolledBackVotedWitnesses = [...(currentAccount.votedWitnesses || []), data.target];
          await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: rolledBackVotedWitnesses } });
          logger.info(`Rolled back witness unvote changes for ${sender}`);
        }
      } catch (rollbackError) {
        logger.error(`Failed to rollback witness unvote changes: ${rollbackError}`);
      }
      
      return false;
    }
  } catch (error) {
    logger.error(`Error processing witness unvote: ${error}`);
    return false;
  }
} 