import cache from '../../cache.js';
import { isValidPubKey } from '../../crypto.js';
import logger from '../../logger.js';

export async function validateTx(data: { pub: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!isValidPubKey(data.pub)) {
            logger.warn(
                `[witness-register:validation] Invalid witness register: public key not provided or invalid format for sender ${sender}. Pub: ${data.pub}`
            );
            return { valid: false, error: 'invalid public key format' };
        }
        const existingWitnessWithKey = await cache.findOnePromise('accounts', {
            witnessPubKey: data.pub,
            name: { $ne: sender },
        });
        if (existingWitnessWithKey) {
            logger.warn(`[witness-register:validation] Invalid witness register: public key ${data.pub} already in use by ${existingWitnessWithKey.name}.`);
            return { valid: false, error: 'public key already in use' };
        }
        return { valid: true };
    } catch (error) {
        logger.error(`[witness-register:validation] Error validating witness register: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: { pub: string }, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        await cache.updateOnePromise('accounts', { name: sender }, { $set: { witnessPublicKey: data.pub } });

        await cache.addWitness(sender, false);
        logger.info(`[witness-register:process] Successfully registered witness: ${sender} with public key: ${data.pub}`);
        return { valid: true };

    } catch (error) {
        logger.error(`[witness-register:process] Error processing witness register: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
