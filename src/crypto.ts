import cloneDeep from 'clone-deep';
import CryptoJS from 'crypto-js';
import secp256k1 from 'secp256k1';
import bs58 from 'bs58';
import cache from './cache.js';
import logger from './logger.js';
import { chain } from './chain.js';
import consensus from './consensus.js';
/**
 * Signs a message using the STEEM_ACCOUNT_PRIV environment variable.
 * @param message The message object to sign (will be mutated with .s field)
 * @returns The signed message object
 */
export function signMessage(message: any): any {
    const hash = CryptoJS.SHA256(JSON.stringify(message)).toString();
    const sigObj = secp256k1.ecdsaSign(Buffer.from(hash, 'hex'), bs58.decode(process.env.WITNESS_PRIVATE_KEY!));
    const signature = bs58.encode(sigObj.signature);
    message.s = {
        n: process.env.STEEM_ACCOUNT,
        s: signature,
    };
    return message;
}

/**
 * Verifies a signed message using the provided public key.
 * @param message The signed message object
 * @param pub The public key to verify against (base58 string)
 * @returns true if valid, false otherwise
 */
export function verifySignature(message: any, cb: (isValid: boolean) => void): void {
    if (!message || !message.s) {
        return cb(false);
    }
    const sign = message.s.s;
    const name = message.s.n

    const tmpMess = cloneDeep(message);
    delete tmpMess.s;
    const hash = CryptoJS.SHA256(JSON.stringify(tmpMess)).toString();
    const pub = consensus.getActiveWitnessKey(name)
    console.log('verifySignature DEBUG: hash =', hash);
    console.log('verifySignature DEBUG: pub =', pub);
    console.log('verifySignature DEBUG: sign =', sign);
    if (
        pub &&
        secp256k1.ecdsaVerify(
            bs58.decode(sign),
            Buffer.from(hash, 'hex'),
            bs58.decode(pub)
        )
    ) {
        cb(true)
        return;
    }
    cb(false)
    return;
}

/**
 * Checks if a given public key is valid (secp256k1, base58 encoded).
 * @param key The public key string
 * @returns true if valid, false otherwise
 */
export function isValidPubKey(key: string): boolean {
    try {
        return secp256k1.publicKeyVerify(bs58.decode(key))
    } catch (error) {
        console.log('isValidPubKey DEBUG: error =', error);
        return false
    }
}

/**
 * Verifies a signature for a user by looking up their account and using their public key.
 * @param user The username
 * @param hash The message hash (hex string)
 * @param sign The signature (base58 string)
 * @returns Promise<boolean> true if valid, false otherwise
 */
export async function isValidSignature(
    user: string,
    hash: string,
    sign: string 
): Promise<string | null> {
    return new Promise((resolve) => {
        cache.findOne('accounts', { name: user }, async function (err: any, account: any) {
            if (err) {
                logger.error(`Database error finding account ${user}:`, err);
                return resolve(account);
            }

            if (!account) {
                logger.error(`Account not found: ${user}`);
                return resolve(null);
            } else if (chain.restoredBlocks && chain.getLatestBlock()._id < chain.restoredBlocks && process.env.REBUILD_NO_VERIFY === '1') {
                // No verify rebuild mode, only use if you trust the contents of blocks.zip
                return resolve(account);
            }

            // Main key can authorize all transactions
            if (!account.witnessPublicKey) {
                logger.error(`No public key found for account: ${user}`);
                return resolve(null);
            }

            try {
              
                try {
                    let bufferHash = Buffer.from(hash, 'hex')
                    let b58sign = bs58.decode(sign)
                    let b58pub = bs58.decode(account.witnessPublicKey)

                    console.log('isValidSignature DEBUG: b58sign =', b58sign);
                    // Verify the signature
                    try {

                        const isValid = secp256k1.ecdsaVerify(b58sign, bufferHash, b58pub);
                        console.log('isValidSignature DEBUG: isValid =', isValid);
                        if (isValid) {
                            return resolve(account);
                        } 
                        else {
                            // Try a simpler verification alternative
                            try {

                                // Force the signature length to be exactly what's expected
                                const fixedSignature = Buffer.alloc(64);
                                let signBuffer = fixedSignature;
                                logger.debug(`- Adjusted signature to length: ${signBuffer.length}`);

                                // Try verification again with adjusted signature
                                const isValidFixed = secp256k1.ecdsaVerify(signBuffer, bufferHash, b58pub);
                                logger.debug(`- Second verification attempt: ${isValidFixed}`);

                                if (isValidFixed) {
                                    logger.debug(`Signature verified for ${user} after adjustment`);
                                    return resolve(null);
                                }

                            } catch (altErr) {
                                logger.error(`Error in alternative verification: ${altErr}`);
                            }

                            logger.error(`Signature verification failed for ${user}`);
                            return resolve(null);
                        }
                    } catch (e) {
                        logger.error(`Error during signature verification: ${e}`);
                        return resolve(null);
                    }

                } catch (e) {
                    logger.error(`Failed to decode signature from base58: ${e}`);
                    return resolve(null);
                }


            } catch (e) {
                logger.error(`General error verifying signature: ${e}`);
                return resolve(null);
            }
        });
    });
}