import logger from '../../logger.js';
import cache from '../../cache.js';
import { updateWitnessVoteWeights } from '../../utils/witness.js';

export async function validateTx(data: { target: string }, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount?.votedWitnesses?.includes(data.target)) {
      logger.warn(`Invalid witness unvote: ${sender} has not voted for ${data.target}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error validating witness unvote: ${error}`);
    return false;
  }
}

export async function process(data: { target: string }, sender: string, transactionId: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    const originalVotedWitnesses = [...(senderAccount?.votedWitnesses || [])];
    const newVotedWitnesses = originalVotedWitnesses.filter((w: string) => w !== data.target);

    const success = await updateWitnessVoteWeights({
      sender,
      oldVotedWitnesses: originalVotedWitnesses,
      newVotedWitnesses,
      targetWitness: data.target,
      isVote: false
    });

    return success;
  } catch (error: any) {
    logger.error('Error processing witness unvote:', error);
    return false;
  }
} 