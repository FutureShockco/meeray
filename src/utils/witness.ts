import logger from '../logger.js';
import cache from '../cache.js';
import { toBigInt, toDbString } from './bigint.js';
import config from '../config.js';

export interface VoteWeightUpdate {
  sender: string;
  oldVotedWitnesses: string[];
  newVotedWitnesses: string[];
  targetWitness: string;
  isVote: boolean; // true for vote, false for unvote
}

/**
 * Updates vote weights for all witnesses when a user's voting pattern changes
 * @param updateData - Data containing the voting change information
 * @returns Promise<boolean> - Success status
 */
export async function updateWitnessVoteWeights(updateData: VoteWeightUpdate): Promise<boolean> {
  try {
    const { sender, oldVotedWitnesses, newVotedWitnesses, targetWitness, isVote } = updateData;
    
    // Get sender's balance
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
      logger.error(`[witness-utils] Sender account ${sender} not found during vote weight update`);
      return false;
    }
    
    const balanceStr = senderAccount.balances?.[config.nativeTokenSymbol] || toDbString(BigInt(0));
    
    // Calculate old and new vote weights per witness
    const oldVoteWeightPerWitness = oldVotedWitnesses.length > 0 ?
      toBigInt(balanceStr) / BigInt(oldVotedWitnesses.length) : BigInt(0);
    const newVoteWeightPerWitness = newVotedWitnesses.length > 0 ?
      toBigInt(balanceStr) / BigInt(newVotedWitnesses.length) : BigInt(0);
    
    // Update sender's voted witnesses list
    await cache.updateOnePromise('accounts', { name: sender }, { 
      $set: { votedWitnesses: newVotedWitnesses } 
    });
    
    // Update vote weights for all affected witnesses
    const allAffectedWitnesses = new Set([...oldVotedWitnesses, ...newVotedWitnesses]);
    
    for (const witnessName of allAffectedWitnesses) {
      const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
      if (!witnessAccount) {
        logger.error(`[witness-utils] Witness account ${witnessName} not found during vote weight adjustment`);
        return false;
      }
      
      const currentVoteWeightStr = witnessAccount.totalVoteWeight || toDbString(BigInt(0));
      let newVoteWeightBigInt: bigint;
      
      if (newVotedWitnesses.includes(witnessName)) {
        // Witness is currently voted for - calculate new vote weight
        newVoteWeightBigInt = newVoteWeightPerWitness;
      } else {
        // Witness is no longer voted for - remove their vote weight
        newVoteWeightBigInt = BigInt(0);
      }
      
      await cache.updateOnePromise('accounts', { name: witnessName }, { 
        $set: { totalVoteWeight: toDbString(newVoteWeightBigInt) } 
      });
    }
    
    return true;
  } catch (error: any) {
    logger.error(`[witness-utils] Error updating witness vote weights: ${error}`);
    return false;
  }
}
