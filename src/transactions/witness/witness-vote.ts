import logger from '../../logger.js';
import cache from '../../cache.js';

export interface WitnessVoteData {
  target: string;
}

export async function validate(data: WitnessVoteData, sender: string): Promise<boolean> {
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

    // Check if the list actually changed. If not (e.g. target was already there and Set removed duplicate),
    // it could be treated as a no-op or an error depending on strictness post-validation.
    // For now, we proceed to calculate new share, which will be same as old if list didn't grow.
    if (newVotedWitnessesList.length === originalVotedWitnesses.length && originalVotedWitnesses.includes(data.target)) {
        logger.warn(`[witness-vote process] Sender ${sender} attempted to vote for ${data.target} again, or validate() check failed. No change to votedWitnesses list.`);
        // Optionally, return true or false here if this should be a no-op or an error.
        // For this iteration, we'll let the share calculations proceed; if the list length is same,
        // shares won't change for existing, and new target won't get newShare if it was pre-existing.
        // However, this means a vote for an existing witness would still run through the update logic for that witness.
        // A stricter approach would be to return `false` or `true` (as a no-op success) here.
        // Let's make it a no-op success to prevent errors but log it.
        return true; 
    }

    // Calculate the new vote share with the new target included
    const newSharePerWitness = newVotedWitnessesList.length > 0 ?
      Math.floor(balance / newVotedWitnessesList.length) : 0;

    try {
      // 1. Update sender's account with the new list of voted witnesses
      await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: newVotedWitnessesList } });

      // 2. Adjust votes for witnesses who were voted for *before* this transaction
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

      // 3. Add the new vote share for the new target witness
      // Since data.target is assumed to be new (not in originalVotedWitnesses),
      // it gets the full newSharePerWitness added to its existing totalVoteWeight.
      // This is an increment, so negative is not a concern here unless newSharePerWitness is somehow negative (should not be).
      logger.debug(`[witness-vote process] Updating target ${data.target} for sender ${sender}: balance=${balance}, newVotedWitnessesList.length=${newVotedWitnessesList.length}, newSharePerWitness=${newSharePerWitness}`);
      await cache.updateOnePromise('accounts', { name: data.target }, { $inc: { totalVoteWeight: newSharePerWitness } });
      
      // Optional: Log target's T VW immediately after to see effect (if feasible without too much async complexity here)
      // const targetAccountAfterInc = await cache.findOnePromise('accounts', { name: data.target });
      // logger.debug(`[witness-vote process] Target ${data.target} totalVoteWeight after $inc: ${targetAccountAfterInc?.totalVoteWeight}`);

      return true;
    } catch (updateError) {
      logger.error(`Error updating accounts during witness vote: ${updateError}`);
      
      // Attempt to rollback sender's votedWitnesses list
      try {
        await cache.updateOnePromise('accounts', { name: sender }, { $set: { votedWitnesses: originalVotedWitnesses } });
        logger.info(`Rolled back sender's votedWitnesses list for ${sender} due to update error.`);
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