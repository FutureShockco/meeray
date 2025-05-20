// Block class and block-related logic
// Direct port from chain.js (logic unchanged, only TS syntax)

import CryptoJS from 'crypto-js';
import secp256k1 from 'secp256k1';
import cloneDeep from 'clone-deep';
import baseX from 'base-x';
import config from './config.js';
import cache from './cache.js';
import transaction from './transaction.js';
import logger from './logger.js';
import { Transaction } from './transactions/index.js';
import chain from './chain.js';
import { isValidSignature, isValidPubKey } from './crypto.js';

const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

export class Block {
    _id!: number;
    blockNum: number;
    steemBlockNum!: number;
    steemBlockTimestamp!: number;
    phash!: string;
    timestamp!: number;
    txs!: any[];
    witness!: string;
    missedBy: string;
    dist: number;
    sync: boolean;
    signature?: string;
    hash?: string;

    constructor(
        _id: number,
        blockNum: number,
        steemBlockNum: number,
        steemBlockTimestamp: number,
        phash: string,
        timestamp: number,
        txs: any[],
        witness: string,
        missedBy?: string,
        dist?: number,
        sync?: boolean,
        signature?: string,
        hash?: string
    ) {
        this._id = _id;
        this.blockNum = blockNum;
        this.steemBlockNum = steemBlockNum;
        this.steemBlockTimestamp = steemBlockTimestamp;
        this.phash = phash;
        this.timestamp = timestamp;
        this.txs = txs;
        this.witness = witness;
        this.missedBy = missedBy || '';
        this.dist = dist || 0;
        this.sync = sync || false;
        if (signature) this.signature = signature;
        if (hash) this.hash = hash;
    }
}


export function calculateHashForBlock(
    blockData: Block,
    deleteExisting?: boolean
): string {
    try {
        let clonedBlock;
        if (deleteExisting === true) {
            clonedBlock = cloneDeep(blockData);
            delete clonedBlock.hash
            delete clonedBlock.signature
        }
        const hash = CryptoJS.SHA256(JSON.stringify(deleteExisting ? clonedBlock : blockData)).toString();
        console.log('calculateHashForBlock DEBUG: hash =', hash);
        return hash;
    } catch (error) {
        logger.error(`Error calculating hash for block ${blockData._id}:`, error);
        return '';
    }
}
// isValidHashAndSignature
export function isValidHashAndSignature(newBlock: any, cb: (valid: boolean) => void) {
    let theoreticalHash = calculateHashForBlock(newBlock, true)
    if (theoreticalHash !== newBlock.hash) {
        logger.debug(typeof (newBlock.hash) + ' ' + typeof theoreticalHash)
        logger.error('invalid hash: ' + theoreticalHash + ' ' + newBlock.hash)
        cb(false); return
    }

    // finally, verify the signature of the miner
    isValidSignature(newBlock.witness, newBlock.hash, newBlock.signature, function (valid) {
        if (!valid) {
            logger.error('invalid miner signature')
            cb(false); return
        }
        cb(true)
    })
}

// isValidBlockTxs
export function isValidBlockTxs(newBlock: any, cb: (valid: boolean) => void) {
    // Revalidate transactions in order
    chain.executeBlockTransactions(newBlock, true, function (validTxs, dist) {
        cache.rollback()
        if (validTxs.length !== newBlock.txs.length) {
            logger.error('invalid block transaction')
            cb(false); return
        }
        let blockDist = newBlock.dist || 0
        if (blockDist !== dist) {
            logger.error('Wrong dist amount', blockDist, dist)
            return cb(false)
        }

        cb(true)
    })
}

export async function isValidNewBlock(newBlock: any, verifyHashAndSignature: boolean, verifyTxValidity: boolean, cb: (isValid: boolean) => void) {
    if (!newBlock) return cb(false);
    if (!newBlock._id || typeof newBlock._id !== 'number') {
        logger.error('invalid block _id');
        return cb(false);
    }
    if (!newBlock.phash || typeof newBlock.phash !== 'string') {
        logger.error('invalid block phash');
        return cb(false);
    }
    if (!newBlock.timestamp || typeof newBlock.timestamp !== 'number') {
        logger.error('invalid block timestamp');
        return cb(false);
    }
    if (!newBlock.txs || typeof newBlock.txs !== 'object' || !Array.isArray(newBlock.txs)) {
        logger.error('invalid block txs');
        return cb(false);
    }
    if (newBlock.txs.length > config.maxTxPerBlock) {
        logger.error('invalid block too many txs');
        return cb(false);
    }
    if (!newBlock.witness || typeof newBlock.witness !== 'string') {
        logger.error('invalid block witness');
        return cb(false);
    }
    if (verifyHashAndSignature && (!newBlock.hash || typeof newBlock.hash !== 'string')) {
        logger.error('invalid block hash');
        return cb(false);
    }
    if (verifyHashAndSignature && (!newBlock.signature || typeof newBlock.signature !== 'string')) {
        logger.error('invalid block signature');
        return cb(false);
    }
    if (newBlock.missedBy && typeof newBlock.missedBy !== 'string') {
        logger.error('invalid block missedBy');
        return cb(false);
    }

    // Check block timestamp is not too far in the future
    const maxDrift = (config as any).maxDrift || 30000;
    if (newBlock.timestamp > Date.now() + maxDrift) {
        logger.error('block timestamp too far in the future');
        return cb(false);
    }
    // verify that its indeed the next block
    const previousBlock = chain.getLatestBlock();
    if (previousBlock._id + 1 !== newBlock._id) {
        logger.error('invalid index')
        cb(false); return
    }
    // from the same chain
    if (previousBlock.hash !== newBlock.phash) {
        logger.error('invalid phash')
        cb(false); return
    }
    // check that the witness is scheduled
    let witnessPriority = 0;
    if (chain.schedule.shuffle[(newBlock._id - 1) % config.witnesses].name === newBlock.witness) {
        witnessPriority = 1;
    } else {
        // Allow backup witnesses if scheduled missed
        for (let i = 1; i <= config.witnesses; i++) {
            const recentBlock = chain.recentBlocks[chain.recentBlocks.length - i];
            if (!recentBlock) break;
            if (recentBlock.witness === newBlock.witness) {
                witnessPriority = i + 1;
                break;
            }
        }
    }
    if (witnessPriority === 0) {
        logger.error('unauthorized witness');
        return cb(false);
    }
    // Check block is not too early for backup
    if (previousBlock && (newBlock.timestamp - previousBlock.timestamp < witnessPriority * config.blockTime)) {
        logger.error('block too early for witness with priority #' + witnessPriority);
        return cb(false);
    }
    if (!verifyTxValidity) {
        if (!verifyHashAndSignature) {
            cb(true); return
        }
        isValidHashAndSignature(newBlock, function (isValid) {
            if (!isValid) {
                logger.error('invalid hash: ' + newBlock.hash)
                cb(false); return
            }
            cb(true)
        })
    } else
        isValidBlockTxs(newBlock, function (isValid) {
            if (!isValid) {
                cb(false); return
            }
            if (!verifyHashAndSignature) {
                cb(true); return
            }
            isValidHashAndSignature(newBlock, function (isValid) {
                if (!isValid) {
                    cb(false); return
                }
                cb(true)
            })
        })
}

