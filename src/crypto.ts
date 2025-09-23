import bs58 from 'bs58';
import cloneDeep from 'clone-deep';
import { randomBytes } from 'crypto';
import CryptoJS from 'crypto-js';
import secp256k1 from 'secp256k1';

import { Block, calculateHashForBlock } from './block.js';
import cache from './cache.js';
import { chain } from './chain.js';
import consensus from './consensus.js';
import logger from './logger.js';

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
    const name = message.s.n;

    const tmpMess = cloneDeep(message);
    delete tmpMess.s;
    const hash = CryptoJS.SHA256(JSON.stringify(tmpMess)).toString();
    const pub = consensus.getActiveWitnessKey(name);

    if (pub && secp256k1.ecdsaVerify(bs58.decode(sign), Buffer.from(hash, 'hex'), bs58.decode(pub))) {
        cb(true);
        return;
    }
    cb(false);
    return;
}

/**
 * Checks if a given public key is valid (secp256k1, base58 encoded).
 * @param key The public key string
 * @returns true if valid, false otherwise
 */
export function isValidPubKey(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    try {
        return secp256k1.publicKeyVerify(bs58.decode(key));
    } catch (error) {
        logger.error('isValidPubKey DEBUG: error =', error);
        return false;
    }
}

/**
 * Verifies a signature for a user by looking up their account and using their public key.
 * @param user The username
 * @param hash The message hash (hex string)
 * @param sign The signature (base58 string)
 * @returns Promise<boolean> true if valid, false otherwise
 */
export async function isValidSignature(user: string, hash: string, sign: string): Promise<any> {
    const account = await cache.findOnePromise('accounts', { name: user });
    if (!account) {
        return false;
    } else if (
        chain.restoredBlocks &&
        chain.getLatestBlock()._id < chain.restoredBlocks &&
        process.env.REBUILD_NO_VERIFY === '1'
    ) {
        // no verify rebuild mode, only use if you trust the contents of blocks.zip
        return account;
    }

    try {
        const bufferHash = Buffer.from(hash, 'hex');
        const b58sign = bs58.decode(sign);
        const b58pub = bs58.decode(account.witnessPublicKey);
        if (secp256k1.ecdsaVerify(b58sign, bufferHash, b58pub)) {
            return account;
        }
    } catch {
        // Ignore error
    }
    return false;
}

export function getNewKeyPair() {
    let privKey, pubKey;
    do {
        privKey = randomBytes(32); // config.randomBytesLength assumed 32
        pubKey = secp256k1.publicKeyCreate(privKey);
    } while (!secp256k1.privateKeyVerify(privKey));
    return {
        pub: bs58.encode(pubKey),
        priv: bs58.encode(privKey),
    };
}

export const hashAndSignBlock = (block: Block): Block => {
    const nextHash = calculateHashForBlock(block);
    const sigObj = secp256k1.ecdsaSign(Buffer.from(nextHash, 'hex'), bs58.decode(process.env.WITNESS_PRIVATE_KEY || ''));
    const signature = bs58.encode(sigObj.signature);
    block.signature = signature;
    block.hash = nextHash;
    return block;
};
