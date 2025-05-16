import cloneDeep from 'clone-deep';
import CryptoJS from 'crypto-js';
import secp256k1 from 'secp256k1';
import bs58 from 'bs58';
import cache  from './cache.js';
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
    sign: string | [string, number][]
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
                // Convert hash from hex to buffer
                const bufferHash = Buffer.from(hash, 'hex');

                // Convert signature from base58 to buffer
                let signBuffer;
                let recoveryId;
                try {
                    // Decode the signature from base58 
                    let signatureString: string;
                    if (typeof sign === 'string') {
                        signatureString = sign;
                    } else if (Array.isArray(sign) && typeof sign[0] === 'string') {
                        signatureString = sign[0];
                    } else {
                        logger.error('Signature is not a string or valid array');
                        return resolve(null);
                    }
                    const decodedSign = bs58.decode(signatureString);

                    // Special handling for different signature formats
                    if (decodedSign.length === 64) {
                        // Standard 64-byte signature without recovery ID
                        logger.debug(`Standard signature format detected (64 bytes)`);
                        signBuffer = Buffer.from(decodedSign);
                        recoveryId = 0; // Default recovery value
                    } else if (decodedSign.length === 65) {
                        // Signature with recovery ID (last byte)
                        signBuffer = Buffer.from(decodedSign.slice(0, 64));
                        recoveryId = decodedSign[64];
                    } else {
                        // Unknown format - try to adapt
                        logger.warn(`Unknown signature format: ${decodedSign.length} bytes, attempting to adapt`);
                        // Use as much of the signature as we can
                        signBuffer = Buffer.from(decodedSign.slice(0, Math.min(decodedSign.length, 64)));
                        recoveryId = decodedSign.length > 64 ? decodedSign[64] : 0;
                    }

                } catch (e) {
                    logger.error(`Failed to decode signature from base58: ${e}`);
                    return resolve(null);
                }

                // Convert public key from base58 to buffer
                let pubKeyBuf;
                try {
                    pubKeyBuf = Buffer.from(bs58.decode(account.witnessPublicKey));

                    // Verify that the public key is valid
                    if (!secp256k1.publicKeyVerify(pubKeyBuf)) {
                        logger.error(`Invalid public key format for ${user}`);
                        return resolve(null);
                    }
                } catch (e) {
                    logger.error(`Failed to decode public key from base58: ${e}`);
                    return resolve(null);
                }

                // Verify the signature
                try {
                    const isValid = secp256k1.ecdsaVerify(signBuffer, bufferHash, pubKeyBuf);

                    if (isValid) {
                        return resolve(account);
                    } else {
                        // Try a simpler verification alternative
                        try {

                            // Force the signature length to be exactly what's expected
                            if (signBuffer.length !== 64) {
                                const fixedSignature = Buffer.alloc(64);
                                signBuffer.copy(fixedSignature, 0, 0, Math.min(signBuffer.length, 64));
                                signBuffer = fixedSignature;
                                logger.debug(`- Adjusted signature to length: ${signBuffer.length}`);

                                // Try verification again with adjusted signature
                                const isValidFixed = secp256k1.ecdsaVerify(signBuffer, bufferHash, pubKeyBuf);
                                logger.debug(`- Second verification attempt: ${isValidFixed}`);

                                if (isValidFixed) {
                                    logger.debug(`Signature verified for ${user} after adjustment`);
                                    return resolve(null);
                                }
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
                logger.error(`General error verifying signature: ${e}`);
                return resolve(null);
            }
        });
    });
}