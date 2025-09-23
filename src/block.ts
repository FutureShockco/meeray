import cloneDeep from 'clone-deep';
import CryptoJS from 'crypto-js';

import cache from './cache.js';
import chain from './chain.js';
import config from './config.js';
import { isValidSignature } from './crypto.js';
import logger from './logger.js';
import p2p from './p2p/index.js';
import steem from './steem.js';

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
    dist: string;
    sync: boolean;
    signature?: string;
    hash?: string;

    // eslint-disable-next-line max-params
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
        dist?: string,
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
        this.dist = dist || '0';
        this.sync = sync || false;
        if (signature) this.signature = signature;
        if (hash) this.hash = hash;
    }
}

export function calculateHashForBlock(blockData: Block, deleteExisting?: boolean): string {
    try {
        const blockToProcess: any = cloneDeep(blockData); // Always clone to avoid modifying the original

        if (deleteExisting === true) {
            delete blockToProcess.hash;
            delete blockToProcess.signature;
        }

        // Create a canonical representation for hashing
        const orderedBlock: any = {};
        Object.keys(blockToProcess)
            .sort()
            .forEach(key => {
                orderedBlock[key] = blockToProcess[key];
            });

        const hash = CryptoJS.SHA256(JSON.stringify(orderedBlock)).toString();
        return hash;
    } catch (error) {
        logger.error(`Error calculating hash for block ${blockData._id}: ${error}`);
        return '';
    }
}

export async function isValidHashAndSignature(newBlock: any): Promise<boolean> {
    const theoreticalHash = calculateHashForBlock(newBlock, true);
    if (theoreticalHash !== newBlock.hash) {
        logger.debug(`Hash types: received = ${typeof newBlock.hash}, calculated = ${typeof theoreticalHash}`);
        logger.error(`invalid hash: calculated = ${theoreticalHash}, received = ${newBlock.hash}`);
        // Log the full newBlock object when there's a hash mismatch
        logger.error(
            `[isValidHashAndSignature] Mismatch detected. Received newBlock object: ${JSON.stringify(newBlock, null, 2)}`
        );
        return false;
    }

    const valid = await isValidSignature(newBlock.witness, newBlock.hash, newBlock.signature);
    if (!valid) {
        logger.error('invalid miner signature');
        return false;
    }
    return true;
}

export function isValidBlockTxs(newBlock: any): Promise<boolean> {
    return new Promise(resolve => {
        chain.executeBlockTransactions(newBlock, true, function (validTxs, dist) {
            cache.rollback();
            if (validTxs.length !== newBlock.txs.length) {
                logger.error('invalid block transaction');
                resolve(false);
                return;
            }
            const blockDist = newBlock.dist || 0;
            if (blockDist !== dist) {
                logger.error('Wrong dist amount', blockDist, dist);
                resolve(false);
                return;
            }

            resolve(true);
        });
    });
}

export const isBlockValid = (newBlock: any, verifyHashAndSignature: boolean): boolean => {
    if (!newBlock._id || typeof newBlock._id !== 'number') {
        logger.error('invalid block _id');
        return false;
    }
    if (!newBlock.phash || typeof newBlock.phash !== 'string') {
        logger.error('invalid block phash');
        return false;
    }
    if (!newBlock.timestamp || typeof newBlock.timestamp !== 'number') {
        logger.error('invalid block timestamp');
        return false;
    }
    if (!newBlock.txs || typeof newBlock.txs !== 'object' || !Array.isArray(newBlock.txs)) {
        logger.error('invalid block txs');
        return false;
    }
    if (newBlock.txs.length > config.maxTxPerBlock) {
        logger.error('invalid block too many txs');
        return false;
    }
    if (!newBlock.witness || typeof newBlock.witness !== 'string') {
        logger.error('invalid block witness');
        return false;
    }
    if (verifyHashAndSignature && (!newBlock.hash || typeof newBlock.hash !== 'string')) {
        logger.error('invalid block hash');
        return false;
    }
    if (verifyHashAndSignature && (!newBlock.signature || typeof newBlock.signature !== 'string')) {
        logger.error('invalid block signature');
        return false;
    }
    if (newBlock.missedBy && typeof newBlock.missedBy !== 'string') {
        logger.error('invalid block missedBy');
        return false;
    }
    return true;
};

export async function isValidNewBlock(
    newBlock: any,
    verifyHashAndSignature: boolean,
    verifyTxValidity: boolean
): Promise<boolean> {
    if (!newBlock) return false;

    if (!isBlockValid(newBlock, verifyHashAndSignature)) {
        return false;
    }
    // Prevent true duplicate blocks (same hash) but allow collision scenarios
    // Check recentBlocks for IDENTICAL blocks (true duplicates)
    const actualDuplicate = chain.recentBlocks.find(
        b => b._id === newBlock._id && b.witness === newBlock.witness && b.hash === newBlock.hash
    );
    if (actualDuplicate) {
        logger.error(`[BLOCK-COLLISION] Identical block already exists in recentBlocks. Rejecting true duplicate.`);
        return false;
    }

    // Check block timestamp is not too far in the future
    const maxDrift = config.maxDrift || 300;
    if (newBlock.timestamp > new Date().getTime() + maxDrift) {
        logger.error('block timestamp too far in the future');
        return false;
    }
    // verify that its indeed the next block
    const previousBlock = chain.getLatestBlock();
    if (previousBlock._id + 1 !== newBlock._id) {
        logger.error('invalid index');
        return false;
    }

    // check that the witness is scheduled
    let witnessPriority = 0;
    if (chain.schedule.shuffle[(newBlock._id - 1) % config.witnesses].name === newBlock.witness) {
        witnessPriority = 1;
    } else {
        // Universal backup: Allow any active witness to serve as backup
        // Check if the witness is in the current shuffle (active witnesses)
        for (let i = 1; i <= config.read(newBlock._id).witnesses; i++) {
            if (!chain.recentBlocks[chain.recentBlocks.length - i]) break;
            if (chain.recentBlocks[chain.recentBlocks.length - i].miner === newBlock.miner) {
                witnessPriority = i + 1;
                break;
            }
        }
    }
    if (witnessPriority === 0) {
        logger.error('unauthorized witness');
        return false;
    }
    const blockTime = newBlock.sync ? config.syncBlockTime : config.blockTime;
    const isRecovering = p2p.recovering || p2p.recoveringBlocks.length > 0 || p2p.recoverAttempt > 0;
    const isReplayMode = process.env.REBUILD_STATE === '1';
    if (newBlock.timestamp - previousBlock.timestamp < witnessPriority * blockTime) {
        if (!isRecovering && !isReplayMode && !steem.isInSyncMode()) {
            logger.error('block too early for witness with priority #' + witnessPriority);
            return false;
        }
    }

    if (!verifyTxValidity) {
        if (!verifyHashAndSignature) {
            return true;
        }
        const isValid = await isValidHashAndSignature(newBlock);
        if (!isValid) {
            logger.error(`invalid hash: ${newBlock.hash}`);
            return false;
        }
        return true;
    } else {
        const isTxsValid = await isValidBlockTxs(newBlock);
        if (!isTxsValid) {
            return false;
        }
        if (!verifyHashAndSignature) {
            return true;
        }
        const isValid = await isValidHashAndSignature(newBlock);
        if (!isValid) {
            return false;
        }
        return true;
    }
}
