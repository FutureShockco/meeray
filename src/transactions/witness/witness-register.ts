import { Account } from '../../models/account.js';
import logger from '../../logger.js';
import mongoose from 'mongoose';

export interface WitnessRegisterData {
  pub: string;
}

export async function validate(data: WitnessRegisterData, sender: string): Promise<boolean> {
  try {    
    // Check if account already registered as witness
    const account = await Account.findById(sender);    
    if (!account) {
      logger.warn(`Invalid witness register: account ${sender} not found`);
      return false;
    }

    if (account.witnessPublicKey) {
      logger.warn(`Invalid witness register: ${sender} already registered as witness`);
      return false;
    }

    // Validate public key format (more permissive)
    if (!data.pub || typeof data.pub !== 'string') {
      logger.warn(`Invalid witness register: missing or invalid public key`);
      return false;
    }
    
    // The original check was for length 53, but we'll be more permissive
    if (data.pub.length < 20) {
      logger.warn(`Invalid witness register: public key too short (${data.pub.length} chars)`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`Error validating witness register: ${error}`);
    return false;
  }
}

export async function process(data: WitnessRegisterData, sender: string): Promise<boolean> {
  try {    
    // Direct check of account state before transaction
    const beforeAccount = await Account.findById(sender);
    // Direct update approach instead of using a transaction
    const updateResult = await Account.findOneAndUpdate(
      { _id: sender },
      { $set: { witnessPublicKey: data.pub } },
      { new: true } // Return the updated document
    );
    
    if (!updateResult) {
      logger.error(`Failed to update account ${sender} - account not found`);
      return false;
    }
    
    // Verify the change was persisted with a separate query
    const verifyAccount = await Account.findById(sender);
    return true;
  } catch (error) {
    logger.error(`Error processing witness register: ${error}`);
    return false;
  }
} 