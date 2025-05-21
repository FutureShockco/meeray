import logger from '../../logger.js';
import cache from '../../cache.js';
import { AccountDoc } from '../../mongo.js'; // Assuming AccountDoc is the type for account documents
import { TransactionType } from '../types.js'; // For logging or specific checks if needed
import config from '../../config.js';

// Data structure for witness_register transaction
export interface WitnessRegisterData {
  pub: string; // Public key for witness operations
}

/**
 * Validates a WITNESS_REGISTER transaction.
 * - Sender must exist.
 * - Public key must be provided.
 * - Sender should not already be an active witness (optional, depends on design).
 */
export async function validateTx(data: WitnessRegisterData, sender: string): Promise<boolean> {
  logger.debug(`[TX_VALIDATE:WITNESS_REGISTER] Validating for sender: ${sender}, pub: ${data.pub}`);
  try {
    // Check if sender account exists
    const senderAccount = await cache.findOnePromise('accounts', { name: sender }) as AccountDoc | null;
    if (!senderAccount) {
      logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: sender account ${sender} not found.`);
      return false;
    }

    // Check if public key is provided
    if (!data.pub || typeof data.pub !== 'string' || data.pub.length < 60) { // Basic length check for a typical pub key
      logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: public key not provided or invalid format for sender ${sender}. Pub: ${data.pub}`);
      return false;
    }

    // Optional: Check if sender is already a witness
    // This depends on whether re-registering (e.g., to update a key) is allowed via this tx type
    // or if there's a separate "witness_update" transaction.
    // For now, we'll allow it, assuming process will handle upsert logic.
    // if (senderAccount.isWitness) { // Assuming an 'isWitness' flag
    //   logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: sender ${sender} is already a witness.`);
    //   return false;
    // }
    
    // Optional: Check if the public key is already in use by another witness
    // This would require querying all witness accounts.
    // const existingWitnessWithKey = await cache.findOnePromise('accounts', { witnessPubKey: data.pub, name: { $ne: sender } });
    // if (existingWitnessWithKey) {
    //    logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: public key ${data.pub} already in use by ${existingWitnessWithKey.name}.`);
    //    return false;
    // }


    logger.debug(`[TX_VALIDATE:WITNESS_REGISTER] Validation successful for sender: ${sender}`);
    return true;
  } catch (error) {
    logger.error(`[TX_VALIDATE:WITNESS_REGISTER] Error validating: ${error}`);
    return false;
  }
}

/**
 * Processes a WITNESS_REGISTER transaction.
 * - Marks the sender as a witness.
 * - Stores their witness public key.
 */
export async function process(data: WitnessRegisterData, sender: string): Promise<boolean> {
  logger.debug(`[TX_PROCESS:WITNESS_REGISTER] Processing for sender: ${sender}, pub: ${data.pub}`);
  try {
    const updateData: Partial<AccountDoc> = {
      witnessPublicKey: data.pub, // Store the public key used for witness operations
      // You might also want to initialize or reset other witness-specific stats here
    };

    const success = await cache.updateOnePromise('accounts', { name: sender }, { $set: updateData });

    if (success) {
      logger.info(`[TX_PROCESS:WITNESS_REGISTER] Account ${sender} successfully queued update for witness registration with pub key ${data.pub}.`);
      // We assume success if cache.updateOnePromise returns true.
      // The actual DB write happens later via cache.writeToDisk.
      // We don't get modifiedCount/matchedCount directly from this call.
      return true;
    } else {
      logger.warn(`[TX_PROCESS:WITNESS_REGISTER] Failed to queue update for account ${sender} to witness.`);
      return false;
    }
  } catch (error) {
    logger.error(`[TX_PROCESS:WITNESS_REGISTER] Error processing: ${error}`);
    return false;
  }
} 