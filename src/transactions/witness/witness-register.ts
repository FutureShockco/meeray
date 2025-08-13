import logger from '../../logger.js';
import cache from '../../cache.js';
import { AccountDoc } from '../../mongo.js';
import { isValidPubKey } from '../../crypto.js';

export interface WitnessRegisterData {
  pub: string;
}

export async function validateTx(data: WitnessRegisterData, sender: string): Promise<boolean> {
  try {
    const senderAccount = await cache.findOnePromise('accounts', { name: sender }) as AccountDoc | null;
    if (!senderAccount) {
      logger.warn(`Invalid witness register: sender account ${sender} not found.`);
      return false;
    }
    if (!data.pub || typeof data.pub !== 'string' || !isValidPubKey(data.pub)) {
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

export async function process(data: WitnessRegisterData, sender: string, transactionId: string): Promise<boolean> {
  try {
    await cache.updateOnePromise('accounts', { name: sender }, { $set: { witnessPublicKey: data.pub } });
    return new Promise((resolve) => {
      cache.addWitness(sender, false, async function (err, witness) {
        if (err) {
          logger.error(`Error adding witness ${sender} to cache: ${err}`);
          resolve(false);
        } else {
          logger.error(`[process] witness: ${witness}`);
          resolve(true);
        }
      });
    });
  } catch (error) {
    logger.error(`Error processing witness register: ${error}`);
    return false;
  }
} 