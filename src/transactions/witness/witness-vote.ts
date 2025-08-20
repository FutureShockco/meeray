import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import { updateWitnessVoteWeights } from '../../utils/witness.js';

export async function validateTx(data: { target: string }, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (senderAccount?.votedWitnesses?.length >= config.maxWitnesses) {
      logger.warn(`Invalid witness vote: ${sender} already voting for ${senderAccount?.votedWitnesses?.length} witnesses`);
      return false;
    }
    if (senderAccount?.votedWitnesses?.includes(data.target)) {
      logger.warn(`Invalid witness vote: ${sender} already voting for witness ${data.target}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error validating witness vote: ${error}`);
    return false;
  }
}

export async function process(data: { target: string }, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    const originalVotedWitnesses = [...(senderAccount?.votedWitnesses || [])];
    const newVotedWitnesses = [...originalVotedWitnesses, data.target];

    const success = await updateWitnessVoteWeights({
      sender,
      oldVotedWitnesses: originalVotedWitnesses,
      newVotedWitnesses,
      targetWitness: data.target,
      isVote: true
    });

    return success;
  } catch (error: any) {
    logger.error('Error processing witness vote:', error);
    return false;
  }
}