import { Account } from '../../models/account.js';
import logger from '../../logger.js';
import mongoose from 'mongoose';

export interface WitnessUnvoteData {
  target: string;
}

export async function validate(data: WitnessUnvoteData, sender: string): Promise<boolean> {
  try {
    // Check if target account exists
    const targetAccount = await Account.findById(data.target);
    if (!targetAccount) {
      logger.warn(`Invalid witness unvote: target account ${data.target} not found`);
      return false;
    }

    // Check if sender has voted for this witness
    const senderAccount = await Account.findById(sender);
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
    const senderAccount = await Account.findById(sender);
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
      senderAccount.votedWitnesses = newVotedWitnesses;
      await senderAccount.save();
      
      // 2. Update vote weights for remaining voted witnesses
      if (newVotedWitnesses.length > 0) {
        await Account.updateMany(
          { _id: { $in: newVotedWitnesses } },
          { $inc: { witnessVotes: newVoteWeight - oldVoteWeight } }
        );
      }
      
      // 3. Remove votes from unvoted witness
      await Account.updateOne(
        { _id: data.target },
        { $inc: { witnessVotes: -oldVoteWeight } }
      );
      
      logger.info(`Witness unvote from ${sender} to ${data.target} processed successfully`);
      return true;
    } catch (updateError) {
      logger.error(`Error updating accounts during witness unvote: ${updateError}`);
      
      // Try to rollback the sender account changes
      try {
        // Only attempt rollback if we managed to save the sender account
        const currentAccount = await Account.findById(sender);
        if (currentAccount && !currentAccount.votedWitnesses?.includes(data.target)) {
          // If the target is no longer in the voted list, add it back
          currentAccount.votedWitnesses = [...(currentAccount.votedWitnesses || []), data.target];
          await currentAccount.save();
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