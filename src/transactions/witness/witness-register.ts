import logger from '../../logger.js';
import cache from '../../cache.js';
import { AccountDoc } from '../../mongo.js';
import { isValidPubKey } from '../../crypto.js';

export interface WitnessRegisterData {
  pub: string;
}

export async function validateTx(data: WitnessRegisterData, sender: string): Promise<boolean> {
  logger.debug(`[TX_VALIDATE:WITNESS_REGISTER] Validating for sender: ${sender}, pub: ${data.pub}`);
  try {
    // Check if sender account exists
    const senderAccount = await cache.findOnePromise('accounts', { name: sender }) as AccountDoc | null;
    if (!senderAccount) {
      logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: sender account ${sender} not found.`);
      return false;
    }

    // Check if public key is provided and is a valid format using crypto.isValidPubKey
    if (!data.pub || typeof data.pub !== 'string' || !isValidPubKey(data.pub)) {
      logger.warn(`[TX_VALIDATE:WITNESS_REGISTER] Invalid: public key not provided or invalid format for sender ${sender}. Pub: ${data.pub}`);
      return false;
    }

    // Optional: Check if the public key is already in use by another witness - (already commented out)
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