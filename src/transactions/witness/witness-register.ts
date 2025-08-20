import logger from '../../logger.js';
import cache from '../../cache.js';
import { isValidPubKey } from '../../crypto.js';

export async function validateTx(data: { pub: string }, sender: string): Promise<boolean> {
  try {
    if (!isValidPubKey(data.pub)) {
      logger.warn(`Invalid witness register: public key not provided or invalid format for sender ${sender}. Pub: ${data.pub}`);
      return false;
    }
    const existingWitnessWithKey = await cache.findOnePromise('accounts', { witnessPubKey: data.pub, name: { $ne: sender } });
    if (existingWitnessWithKey) {
      logger.warn(`Invalid witness register: public key ${data.pub} already in use by ${existingWitnessWithKey.name}.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error validating witness register: ${error}`);
    return false;
  }
}

export async function process(data: { pub: string }, sender: string, transactionId: string): Promise<boolean> {
  try {
    await cache.updateOnePromise('accounts', { name: sender }, { $set: { witnessPublicKey: data.pub } });

    try {
      await cache.addWitness(sender, false);
      logger.info(`[process] Successfully registered witness: ${sender} with public key: ${data.pub}`);
      return true;
    } catch (err) {
      logger.error(`Error adding witness ${sender} to cache: ${err}`);
      return false;
    }
  } catch (error) {
    logger.error(`Error processing witness register: ${error}`);
    return false;
  }
} 