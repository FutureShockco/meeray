import logger from '../../logger.js';
import cache from '../../cache.js';
import config from '../../config.js';
import { witnessesModule } from '../../witnesses.js';

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
    const adjustedWitnessWeight = await witnessesModule.updateWitnessVoteWeights({
      sender,
      targetWitness: data.target,
      isVote: false,
      isUnvote: true
    });
    if (!adjustedWitnessWeight) {
      logger.error(`[witness-unvote:process] Failed to adjust witness weights for unvote by ${sender} on ${data.target}`);
      return false;
    }
    return true
  } catch (error: any) {
    logger.error('Error processing witness vote:', error);
    return false;
  }
}