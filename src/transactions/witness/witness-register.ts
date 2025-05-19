import logger from '../../logger.js';
import cache from '../../cache.js';
import { isValidPubKey } from '../../crypto.js';

export interface WitnessRegisterData {
  pub: string;
}

export async function validateTx(data: WitnessRegisterData, sender: string): Promise<boolean> {
  try {
    // Check if account already registered
    const account = await cache.findOnePromise('accounts', { name: sender });
    if (!account) {
      logger.warn(`Invalid witness register: account ${sender} not found`);
      return false;
    }

    // Validate public key format (more permissive)
    if (!data.pub || typeof data.pub !== 'string') {
      logger.warn(`Invalid witness register: missing or invalid public key`);
      return false;
    }

    // Check if public key is valid
    if (isValidPubKey(data.pub)) {
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
    const beforeAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!beforeAccount) {
      logger.error(`Failed to check account ${sender} - account not found`);
      return false;
    }
    // Direct update approach instead of using a transaction
    const updateSuccess = await cache.updateOnePromise('accounts', { name: sender }, { $set: { witnessPublicKey: data.pub } });
    if (!updateSuccess) {
      logger.error(`Failed to update account ${sender} via cache - account not found in cache or update failed`);
      return false;
    }

    // Verify the change was persisted with a separate query (from cache, which should reflect the update)
    const verifyAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!verifyAccount || verifyAccount.witnessPublicKey !== data.pub) { // Check if the pubkey was actually updated
      logger.error(`Failed to verify account update for ${sender} - account not found or public key not updated in cache`);
      return false;
    }
    return new Promise((resolve) => {
      cache.addWitness(sender, false, function(err, witness) {
        if (err) {
          logger.error(`Error adding witness ${sender} to cache: ${err}`);
          resolve(false);
        } else {
          logger.debug(`[process] witness: ${witness}`);
          resolve(true);
        }
      });
    });
  } catch (error) {
    logger.error(`Error processing witness register: ${error}`);
    return false;
  }
} 