import logger from '../../logger.js';
import cache from '../../cache.js';

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

    // Validate function should ensure data.target is not already in senderAccount.votedWitnesses
    // If it might be (e.g., validate was bypassed), this logic needs to be more robust
    // For now, assume validate works as intended.

    const originalVotedWitnesses = [...senderAccount.votedWitnesses]; // Witnesses before this vote
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
      // Their vote share changes from oldSharePerWitness to newSharePerWitness
      const adjustment = newSharePerWitness - oldSharePerWitness; // This will be negative or zero

      for (const witnessName of originalVotedWitnesses) {
        if (adjustment === 0) continue; // No change in share for this witness

        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
        if (witnessAccount) {
          const currentTotalVoteWeight = witnessAccount.totalVoteWeight || 0;
          // Since adjustment is negative, adding it will decrease. Clamp at 0.
          const finalTotalVoteWeight = Math.max(0, currentTotalVoteWeight + adjustment);
          await cache.updateOnePromise('accounts', { name: witnessName }, { $set: { totalVoteWeight: finalTotalVoteWeight } });
        } else {
          logger.error(`[witness-vote] Witness account ${witnessName} not found when trying to adjust totalVoteWeight.`);
          // Consider error handling/rollback implications
        }
      }

      logger.debug(`[witness-vote process] Updating target ${data.target} for sender ${sender}: balance=${balance}, newVotedWitnessesList.length=${newVotedWitnessesList.length}, newSharePerWitness=${newSharePerWitness}`);
      await cache.updateOnePromise('accounts', { name: data.target }, { $inc: { totalVoteWeight: newSharePerWitness } });
      
      return true;
    } catch (updateError) {
      logger.error(`Error updating accounts during witness vote: ${updateError}`);
      
      // Attempt to rollback sender's votedWitnesses list
      try {
        await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: originalVotedWitnesses } });
        logger.warn(`Rolled back sender's votedWitnesses list for ${sender} due to update error.`);
        // Note: Rolling back individual totalVoteWeight adjustments is much more complex and not attempted here.
      } catch (rollbackError) {
        logger.error(`Failed to rollback sender's votedWitnesses list: ${rollbackError}`);
      }
      return false;
    }
  } catch (error) {
    logger.error(`Error processing witness vote: ${error}`);
    return false;
  }
} 