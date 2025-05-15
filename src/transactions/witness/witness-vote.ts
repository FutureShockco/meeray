import { Account } from '../../models/account.js';
import logger from '../../logger.js';
import mongoose from 'mongoose';

export interface WitnessVoteData {
  target: string;
}

export async function validate(data: WitnessVoteData, sender: string): Promise<boolean> {
  try {
    // Check if target account exists
    const targetAccount = await Account.findById(data.target);
    if (!targetAccount) {
      logger.warn(`Invalid witness vote: target account ${data.target} not found`);
      return false;
    }

    // Check if sender account exists
    const senderAccount = await Account.findById(sender);
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
    const senderAccount = await Account.findById(sender);
    if (!senderAccount) {
      logger.error(`Sender account ${sender} not found for witness vote`);
      return false;
    }
    
    // Initialize votedWitnesses array if it doesn't exist
    if (!senderAccount.votedWitnesses) {
      senderAccount.votedWitnesses = [];
    }
    
    // Make a local copy to avoid TypeScript errors
    const votedWitnesses = [...(senderAccount.votedWitnesses || [])];
    
    // Add the new vote to calculate correct weights
    votedWitnesses.push(data.target);
    
    // Calculate vote weight based on token balance divided by number of votes
    const balance = senderAccount.tokens?.ECH || 0;
    const newVoteWeight = Math.floor(balance / votedWitnesses.length);
    const oldVoteWeight = votedWitnesses.length > 1 ? 
      Math.floor(balance / (votedWitnesses.length - 1)) : 0;
    
    try {
      // Update in sequence instead of using transactions
      
      // 1. Update sender account with new vote
      senderAccount.votedWitnesses = votedWitnesses;
      await senderAccount.save();
      
      // 2. Update vote weights for all voted witnesses
      if (votedWitnesses.length > 1) {
        // Update weights for previously voted witnesses
        await Account.updateMany(
          { _id: { $in: votedWitnesses.filter(w => w !== data.target) } },
          { $inc: { witnessVotes: newVoteWeight - oldVoteWeight } }
        );
      }
      
      // 3. Add new vote weight for the target witness
      await Account.updateOne(
        { _id: data.target },
        { $inc: { witnessVotes: newVoteWeight } }
      );
      
      return true;
    } catch (updateError) {
      logger.error(`Error updating accounts during witness vote: ${updateError}`);
      
      // Try to rollback the sender account changes
      try {
        // Only attempt rollback if we managed to save the sender account
        const currentAccount = await Account.findById(sender);
        if (currentAccount && currentAccount.votedWitnesses?.includes(data.target)) {
          currentAccount.votedWitnesses = currentAccount.votedWitnesses.filter((w: string) => w !== data.target);
          await currentAccount.save();
          logger.info(`Rolled back witness vote changes for ${sender}`);
        }
      } catch (rollbackError) {
        logger.error(`Failed to rollback witness vote changes: ${rollbackError}`);
      }
      
      return false;
    }
  } catch (error) {
    logger.error(`Error processing witness vote: ${error}`);
    return false;
  }
} 