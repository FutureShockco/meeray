import { chain } from './chain.js';
import { Block, isValidNewBlock } from './block.js';
import config from './config.js';
import transaction from './transaction.js';
import secp256k1 from 'secp256k1';
import baseX from 'base-x';
import logger from './logger.js';
import { calculateHashForBlock } from './block.js';
import steem from './steem.js';
import { Transaction } from './transactions/index.js';
import cache from './cache.js';
import consensus from './consensus.js';
import p2p from './p2p.js';
import witnessesModule from './witnesses.js';
const bs58 = baseX(config.b58Alphabet);

export const mining = {
    /**
     * Prepare a new block with transactions from the mempool.
     */
    prepareBlock: (cb: (err: any, newBlock?: any) => void) => {
        let previousBlock = chain.getLatestBlock();
        let nextIndex = previousBlock._id + 1;
        let nextTimestamp = new Date().getTime();
        let nextSteemBlockNum = previousBlock.steemBlockNum + 1;
        let nextSteemBlockTimestamp = previousBlock.steemBlockTimestamp + config.blockTime;

        steem.processBlock(nextSteemBlockNum).then((transactions) => {
            if (!transactions) {
                // Handle the case where the Steem block doesn't exist yet
                if (steem.getBehindBlocks() <= 0) {
                    logger.debug(`Cannot prepare block - Steem block ${nextSteemBlockNum} not found, but we're caught up with Steem head. Retrying in 1 second...`)

                    // If we're at the head of Steem, wait a bit and let the caller retry
                    setTimeout(() => {
                        cb(true, null)
                    }, 1000)
                    return; // Add explicit return to prevent further execution
                }

                logger.warn(`Cannot prepare block - Steem block ${nextSteemBlockNum} not found, behind by ${steem.getBehindBlocks()} blocks`)
                cb(true, null)
                return; // Add explicit return to prevent further execution
            }

            // Add mempool transactions
            let txs = []
            let mempool = transaction.pool.sort((a: any, b: any) => a.ts - b.ts);

            loopOne:
            for (let i = 0; i < mempool.length; i++) {
                if (txs.length === config.maxTxPerBlock)
                    break
                // do not allow multiple txs from same account in the same block
                for (let y = 0; y < txs.length; y++)
                    if (txs[y].sender === mempool[i].sender)
                        continue loopOne
                txs.push(mempool[i])
            }

            loopTwo:
            for (let i = 0; i < mempool.length; i++) {
                if (txs.length === config.maxTxPerBlock)
                    break
                for (let y = 0; y < txs.length; y++)
                    if (txs[y].hash === mempool[i].hash)
                        continue loopTwo
                txs.push(mempool[i])
            }
            txs = txs.sort((a: any, b: any) => a.ts - b.ts);

            transaction.removeFromPool(txs)

            // Create the initial block
            let newBlock: Block = {
                _id: nextIndex,
                blockNum: nextIndex,
                phash: previousBlock.hash,
                timestamp: nextTimestamp,
                steemBlockNum: nextSteemBlockNum,
                steemBlockTimestamp: nextSteemBlockTimestamp,
                txs: txs,
                witness: process.env.STEEM_ACCOUNT || '',
                missedBy: '',
                dist: 0,
                hash: '',
                signature: '',
                sync: steem.isInSyncMode() || false
            };

            // Set distribution amount based on witness rewards
            if (config.witnessReward > 0) {
                newBlock.dist = config.witnessReward
            }
            // hash and sign the block with our private key
            newBlock = mining.hashAndSignBlock(newBlock)
            cb(null, newBlock)
        }).catch((error) => {
            logger.error(`Error processing Steem block ${nextSteemBlockNum}:`, error)
            cb(true, null)
        })
    },

    /**
     * Check if this node can mine the next block.
     */
    canMineBlock: (cb: (err: boolean | null, newBlock?: any) => void) => {
        if ((chain as any).shuttingDown) {
            cb(true, null); return;
        }
        mining.prepareBlock((err, newBlock) => {
            if (newBlock === null || newBlock === undefined) {
                cb(true, null); return;
            }
            isValidNewBlock(newBlock, false, false, function (isValid: boolean) {
                if (!isValid) {
                    cb(true, newBlock); return;
                }
                cb(null, newBlock);
            });
        });
    },

    /**
     * Mine a new block and propose it to consensus.
     */
    mineBlock: (cb: (err: boolean | null, newBlock?: any) => void) => {
        if ((chain as any).shuttingDown) return;
        mining.canMineBlock(function (err, newBlock) {
            if (err) {
                cb(true, newBlock); return;
            }
            // at this point transactions in the pool seem all validated
            // BUT with a different ts and without checking for double spend
            // so we will execute transactions in order and revalidate after each execution
            chain.executeBlockTransactions(newBlock, true, function (validTxs: Transaction[], distributed: number) {
                try {
                    cache.rollback()
                    // Assign the executed transactions to the block (fix)
                    newBlock.txs = validTxs;

                    // always record the failure of others
                    if (chain.schedule && chain.schedule.shuffle &&
                        chain.schedule.shuffle[(newBlock._id - 1) % config.witnesses].name !== process.env.STEEM_ACCOUNT) {
                        newBlock.missedBy = chain.schedule.shuffle[(newBlock._id - 1) % config.witnesses].name;
                    }

                    if (distributed) newBlock.dist = distributed;

                    // hash and sign the block with our private key
                    newBlock = mining.hashAndSignBlock(newBlock);

                    // push the new block to consensus possible blocks
                    // and go straight to end of round 0 to skip re-validating the block
                    if (!consensus) {
                        logger.error('Consensus module not available');
                        return cb(true, null);
                    }

                    let possBlock: any = {
                        block: newBlock
                    };
                    for (let r = 0; r < config.consensusRounds; r++)
                        possBlock[r] = [];

                    logger.debug('Mined a new block, proposing to consensus');

                    possBlock[0].push(process.env.STEEM_ACCOUNT);
                    consensus.possBlocks.push(possBlock);
                    consensus.endRound(0, newBlock);
                    cb(null, newBlock);
                } catch (error) {
                    logger.error('Error while finalizing block:', error);
                    cb(true, null);
                }
            });
        });
    },

    /**
     * Worker function to schedule mining attempts.
     */
    minerWorker: (block: Block): void => {
        if (p2p.recovering) {
            logger.debug('Mining skipped: Node is recovering');
            clearTimeout(chain.worker)
            return;
        }


        if (!chain.schedule || !chain.schedule.shuffle || chain.schedule.shuffle.length === 0) {
            logger.error('All witnesses gave up their stake? Chain is over');
            process.exit(1);
        }
        const configBlock = config.read(chain.getLatestBlock()._id);

        let mineInMs: number | null = null;
        if (chain.schedule.shuffle[(block._id) % config.witnesses].name === process.env.STEEM_ACCOUNT)
            mineInMs = config.blockTime
        // else if the scheduled witnesses miss blocks
        // backups witnesses are available after each block time intervals
        else for (let i = 1; i < 2 * config.witnesses; i++)
            if (chain.recentBlocks[chain.recentBlocks.length - i]
                && chain.recentBlocks[chain.recentBlocks.length - i].miner === process.env.STEEM_ACCOUNT) {
                mineInMs = (i + 1) * config.blockTime
                break
            }
        // Get the appropriate block time based on sync state
        let blockTime = steem.isInSyncMode()
            ? configBlock.syncBlockTime
            : configBlock.blockTime;

        // Log which block time we're using for clarity
        if (steem.isInSyncMode()) {
            logger.debug(`Using sync block time: ${blockTime}ms`);
        } else if (steem.lastSyncExitTime && new Date().getTime() - steem.lastSyncExitTime < 5000) {
            logger.warn(`Recently exited sync mode, using normal block time: ${blockTime}ms`);
        }

        if (mineInMs !== null) {
            mineInMs -= (new Date().getTime() - block.timestamp)
            mineInMs += 40
            logger.debug(`Will attempt to mine in ${mineInMs}ms`);
            consensus.observer = false

            if (mineInMs < config.blockTime / 2) {
                logger.warn('Slow performance detected, will not try to mine next block')
                return
            }
            chain.worker = setTimeout(function () {
                mining.mineBlock(function (error, finalBlock) {
                    if (error)
                        logger.warn('miner worker trying to mine but couldnt', finalBlock)
                })
            }, mineInMs)
        }
    },
    hashAndSignBlock: (block: Block): Block => {
        try {
            const nextHash = calculateHashForBlock({
                _id: block._id,
                blockNum: block.blockNum,
                phash: block.phash,
                timestamp: block.timestamp,
                steemBlockNum: block.steemBlockNum,
                steemBlockTimestamp: block.steemBlockTimestamp,
                txs: block.txs,
                witness: block.witness,
                missedBy: block.missedBy || '',
                dist: block.dist || 0,
                sync: block.sync,
            }); 

            logger.debug(`Signing block ${block._id} with hash: ${nextHash.substring(0, 10)}...`);

            // Convert hex string hash to buffer
            const msgBuffer = Buffer.from(nextHash, 'hex');
            logger.debug(`Hash buffer created: ${msgBuffer.length} bytes`);

            // Check if we have a witness private key
            if (!process.env.WITNESS_PRIVATE_KEY) {
                logger.error('No WITNESS_PRIVATE_KEY defined, cannot sign block');
                return {
                    ...block,
                    hash: nextHash,
                    signature: ''
                };
            }
            // Get private key as buffer
            let privKeyBuffer;
            try {
                privKeyBuffer = bs58.decode(process.env.WITNESS_PRIVATE_KEY);

                // Verify private key is valid
                if (!secp256k1.privateKeyVerify(privKeyBuffer)) {
                    logger.error('Invalid private key format');
                    return {
                        ...block,
                        hash: nextHash,
                        signature: ''
                    };
                }
            } catch (e) {
                logger.error(`Failed to decode private key: ${e}`);
                return {
                    ...block,
                    hash: nextHash,
                    signature: ''
                };
            }

            // Sign the message
            let signResult;
            try {
                signResult = secp256k1.ecdsaSign(msgBuffer, privKeyBuffer);

                // Combine signature and recovery ID into a single buffer
                let signature = bs58.encode(signResult.signature)

                return {
                    ...block,
                    hash: nextHash,
                    signature: signature
                };
            } catch (e) {
                logger.error(`Failed to sign message: ${e}`);
                return {
                    ...block,
                    hash: nextHash,
                    signature: ''
                };
            }
        } catch (error) {
            logger.error(`Unexpected error signing block ${block._id}: ${error}`, error);
            return {
                ...block,
                hash: '',
                signature: ''
            };
        }
    },
};

export default mining; 