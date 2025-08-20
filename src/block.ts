import CryptoJS from 'crypto-js';
import cloneDeep from 'clone-deep';
import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import chain from './chain.js';
import { isValidSignature } from './crypto.js';
import steem from './steem.js';
import p2p from './p2p.js';


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


export function calculateHashForBlock(
    blockData: Block,
    deleteExisting?: boolean
): string {
    try {
        let blockToProcess: any = cloneDeep(blockData); // Always clone to avoid modifying the original

        if (deleteExisting === true) {
            delete blockToProcess.hash;
            delete blockToProcess.signature;
        }

        // Create a canonical representation for hashing
        const orderedBlock: any = {};
        Object.keys(blockToProcess).sort().forEach(key => {
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
    let theoreticalHash = calculateHashForBlock(newBlock, true)
    if (theoreticalHash !== newBlock.hash) {
        logger.debug(`Hash types: received = ${typeof (newBlock.hash)}, calculated = ${typeof theoreticalHash}`);
        logger.error(`invalid hash: calculated = ${theoreticalHash}, received = ${newBlock.hash}`);
        // Log the full newBlock object when there's a hash mismatch
        logger.error(`[isValidHashAndSignature] Mismatch detected. Received newBlock object: ${JSON.stringify(newBlock, null, 2)}`);
        return false;
    }

    const valid = await isValidSignature(newBlock.witness, newBlock.hash, newBlock.signature);
    if (!valid) {
        logger.error('invalid miner signature')
        return false;
    }
    return true;
}

export function isValidBlockTxs(newBlock: any): Promise<boolean> {
    return new Promise((resolve) => {
        chain.executeBlockTransactions(newBlock, true, function (validTxs, dist) {
            cache.rollback()
            if (validTxs.length !== newBlock.txs.length) {
                logger.error('invalid block transaction')
                resolve(false);
                return;
            }
            let blockDist = newBlock.dist || 0
            if (blockDist !== dist) {
                logger.error('Wrong dist amount', blockDist, dist)
                resolve(false);
                return;
            }

            resolve(true);
        })
    });
}

export async function isValidNewBlock(newBlock: any, verifyHashAndSignature: boolean, verifyTxValidity: boolean): Promise<boolean> {
    if (!newBlock) return false;
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

    // Check block timestamp is not too far in the future
    const maxDrift = config.maxDrift || 30000;
    if (newBlock.timestamp > Date.now() + maxDrift) {
        logger.error('block timestamp too far in the future');
        return false;
    }
    // verify that its indeed the next block
    const previousBlock = chain.getLatestBlock();
    if (previousBlock._id + 1 !== newBlock._id) {
        logger.error('invalid index')
        return false;
    }
    
    // Enhanced phash validation with sync mode reconciliation
    if (previousBlock.hash !== newBlock.phash) {
        // Check if this is a sync mode scenario where we should be more lenient with logging
        const isSyncMode = steem.isInSyncMode();
        const isLenientMode = steem.shouldBeLenient && steem.shouldBeLenient(newBlock._id);
        
        if (isSyncMode || isLenientMode) {
            // In sync mode, log the mismatch but still reject to maintain consensus
            // This provides better diagnostics without risking chain forks
            logger.warn(`[SYNC-MODE] Block ${newBlock._id} from ${newBlock.witness} has phash mismatch. Expected: ${previousBlock.hash}, got: ${newBlock.phash}. Rejecting to maintain consensus.`);
            
            // Check if this references a recently seen block for diagnostic purposes
            const maxLookback = Math.min(chain.recentBlocks.length, 5); // Small lookback for diagnostics only
            let foundReference = false;
            
            for (let i = 1; i <= maxLookback; i++) {
                const historicalBlock = chain.recentBlocks[chain.recentBlocks.length - i];
                if (historicalBlock && historicalBlock.hash === newBlock.phash) {
                    foundReference = true;
                    logger.info(`[SYNC-DIAGNOSTIC] Block references historical block ${historicalBlock._id}#${historicalBlock.hash.substr(0, 4)} by ${historicalBlock.witness}. This suggests delayed block propagation.`);
                    break;
                }
            }
            
            if (!foundReference && chain.alternativeBlocks) {
                const altBlock = chain.alternativeBlocks.find(ab => ab.hash === newBlock.phash);
                if (altBlock) {
                    logger.info(`[SYNC-DIAGNOSTIC] Block references alternative block ${altBlock._id}#${altBlock.hash.substr(0, 4)} by ${altBlock.witness}. This suggests post-collision block creation.`);
                }
            }
            
            if (!foundReference) {
                logger.info(`[SYNC-DIAGNOSTIC] Block phash ${newBlock.phash.substr(0, 8)} does not match any recently seen blocks. This may indicate a deeper sync issue.`);
            }
        }
        
        // Always reject phash mismatches to maintain consensus integrity
        logger.error('invalid phash')
        return false;
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
        return false;
    }
    const blockTime = newBlock.sync ? config.syncBlockTime : config.blockTime;
    // Check block is not too early for backup (skip during recovery/replay)
    if (previousBlock && (newBlock.timestamp - previousBlock.timestamp < witnessPriority * blockTime)) {
        // During recovery/replay, we need to be more lenient with timing validation
        // as historical blocks may have been mined in rapid succession
        
        // Check multiple recovery indicators for robustness
        const isRecovering = p2p.recovering || p2p.recoveringBlocks.length > 0 || p2p.recoverAttempt > 0;
        const isHistoricalBlock = newBlock.timestamp < (Date.now() - 24 * 60 * 60 * 1000); // Block older than 24 hours
        const isReplayMode = process.env.REBUILD_STATE === '1';
        
        logger.debug(`[TIMING-CHECK] Block ${newBlock._id}: timeDiff=${newBlock.timestamp - previousBlock.timestamp}, required=${witnessPriority * blockTime}, priority=#${witnessPriority}, recovering=${isRecovering}, historical=${isHistoricalBlock}, rebuild=${isReplayMode}, p2p.recovering=${p2p.recovering}, recoveringBlocks=${p2p.recoveringBlocks.length}, recoverAttempt=${p2p.recoverAttempt}`);
        
        if (!isRecovering && !isHistoricalBlock && !isReplayMode) {
            logger.error('block too early for witness with priority #' + witnessPriority);
            return false;
        } else {
            logger.info(`[RECOVERY] Allowing block timing validation bypass for block ${newBlock._id} with witness priority #${witnessPriority} (recovering=${isRecovering}, historical=${isHistoricalBlock}, rebuild=${isReplayMode})`);
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

