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
    
    // Update vote weights for remaining witnesses (if any)
    if (newVotedWitnesses.length > 0) {
      const adjustmentForRemaining = newVoteWeightPerWitness - oldVoteWeightPerWitness;
      
      for (const witnessName of newVotedWitnesses) {
        const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
        if (witnessAccount) {
          const currentVoteWeightStr = witnessAccount.totalVoteWeight || toDbString(BigInt(0));
          const newVoteWeightBigInt = toBigInt(currentVoteWeightStr) + adjustmentForRemaining;
          await cache.updateOnePromise('accounts', { name: witnessName }, { 
            $set: { totalVoteWeight: toDbString(newVoteWeightBigInt) } 
          });
        } else {
          logger.error(`[witness-utils] Witness account ${witnessName} not found during vote weight adjustment`);
          return false;
        }
      }
    }
    
    // Update target witness vote weight
    const targetAccount = await cache.findOnePromise('accounts', { name: targetWitness });
    if (!targetAccount) {
      logger.error(`[witness-utils] Target witness account ${targetWitness} not found`);
      return false;
    }
    
    const currentTargetVoteWeightStr = targetAccount.totalVoteWeight || toDbString(BigInt(0));
    let newTargetVoteWeightBigInt: bigint;
    
    if (isVote) {
      // Adding vote - add the new vote weight
      newTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr) + newVoteWeightPerWitness;
    } else {
      // Removing vote - subtract the old vote weight
      newTargetVoteWeightBigInt = toBigInt(currentTargetVoteWeightStr) - oldVoteWeightPerWitness;
      if (newTargetVoteWeightBigInt < BigInt(0)) {
        newTargetVoteWeightBigInt = BigInt(0);
      }
    }
    
    await cache.updateOnePromise('accounts', { name: targetWitness }, { 
      $set: { totalVoteWeight: toDbString(newTargetVoteWeightBigInt) } 
    });
    
    return true;
  } catch (error: any) {
    logger.error(`[witness-utils] Error updating witness vote weights: ${error}`);
    return false;
  }
}
