import logger from '../../logger.js';
import cache from '../../cache.js';
import { witnessesModule } from '../../witnesses.js';

export async function validateTx(data: { target: string }, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount?.votedWitnesses?.includes(data.target)) {
      logger.warn(`[witness-unvote:validation] Invalid witness unvote: ${sender} has not voted for ${data.target}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`[witness-unvote:validation] Error validating witness unvote: ${error}`);
    return false;
  }
}

export async function process(data: { target: string }, sender: string, transactionId: string): Promise<boolean> {
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

    return true;
  } catch (error: any) {
    logger.error('[witness-unvote:process] Error processing witness unvote:', error);
    return false;
  }
} 