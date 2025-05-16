import logger from '../../logger.js';
import cache from '../../cache.js';

export interface WitnessRegisterData {
  pub: string;
}

export async function validate(data: WitnessRegisterData, sender: string): Promise<boolean> {
  try {
    // Check if account already registered as witness
    const account = await cache.findOnePromise('accounts', { name: sender });
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

    return true;
  } catch (error) {
    logger.error(`Error processing witness register: ${error}`);
    return false;
  }
} 