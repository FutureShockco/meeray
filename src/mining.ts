import { chain } from './chain.js';
import { Block, isValidNewBlock } from './block.js';
import config from './config.js';
import transaction from './transaction.js';
import logger from './logger.js';
import steem from './steem.js';
import { Transaction } from './transactions/index.js';
import cache from './cache.js';
import consensus from './consensus.js';
import p2p from './p2p.js';
import { hashAndSignBlock } from './crypto.js';

export const mining = {

    prepareBlock: (cb: (err: any, newBlock?: any) => void) => {
        logger.debug('[MINING:prepareBlock] Entered.');
        let previousBlock = chain.getLatestBlock();
        if (!previousBlock) {
            logger.error('[MINING:prepareBlock] Cannot get latest block from chain. Aborting.');
            cb(true, null);
            return;
        }
        let nextIndex = previousBlock._id + 1;

        // Determine the correct timestamp for the new block
        const targetBlockInterval = steem.isInSyncMode() ? config.syncBlockTime : config.blockTime;
        const minTimestampForNewBlock = previousBlock.timestamp + targetBlockInterval;
        const currentSystemTime = new Date().getTime();

        // Ensure the new block's timestamp is at least minTimestampForNewBlock for the current mode,
        // but use currentSystemTime if it's later, allowing the chain to progress naturally if there were delays.
        let nextTimestamp = Math.max(currentSystemTime, minTimestampForNewBlock);

        // isValidNewBlock should be the ultimate arbiter of whether a timestamp is too far in the future.

        // Steem block numbers and timestamps in the Echelon block are related to the Steem block being processed,
        // not directly to Echelon block timing intervals in the same way Echelon timestamps are.
        let nextSteemBlockNum = previousBlock.steemBlockNum + 1;
        let nextSteemBlockTimestamp = previousBlock.steemBlockTimestamp + targetBlockInterval; // Approximate, actual comes from Steem block

        logger.debug(`[MINING:prepareBlock] Mode: ${steem.isInSyncMode() ? 'SYNC' : 'NORMAL'}, TargetInterval: ${targetBlockInterval}ms`);
        logger.debug(`[MINING:prepareBlock] previousBlock ID: ${previousBlock._id}, timestamp: ${new Date(previousBlock.timestamp).toISOString()}`);
        logger.debug(`[MINING:prepareBlock] Calculated minTimestampForNewBlock: ${new Date(minTimestampForNewBlock).toISOString()}, currentSystemTime: ${new Date(currentSystemTime).toISOString()}, chosen nextTimestamp: ${new Date(nextTimestamp).toISOString()}`);
        logger.debug(`[MINING:prepareBlock] Attempting to process Steem virtual op block corresponding to Echelon block ${nextIndex} using Steem block number ${nextSteemBlockNum}.`);

        steem.processBlock(nextSteemBlockNum).then((transactions) => {
            if (!transactions) {
                // Handle the case where the Steem block doesn't exist yet
                if (steem.getBehindBlocks() <= 0) {
                    logger.debug(`[MINING:prepareBlock] Steem block ${nextSteemBlockNum} not found, but caught up. Retrying.`);

                    // If we're at the head of Steem, wait a bit and let the caller retry
                    setTimeout(() => {
                        cb(true, null)
                    }, 1000)
                    return; // Add explicit return to prevent further execution
                }

                logger.warn(`[MINING:prepareBlock] Steem block ${nextSteemBlockNum} not found, behind by ${steem.getBehindBlocks()} blocks. Cannot prepare Echelon block.`);
                cb(true, null)
                return; // Add explicit return to prevent further execution
            }
            logger.debug(`[MINING:prepareBlock] Successfully processed Steem block ${nextSteemBlockNum}. Transactions found: ${transactions.transactions.length}`);

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

            logger.debug(`[MINING:prepareBlock] Added ${txs.length} transactions from mempool.`);

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
                dist: '0',
                sync: steem.isInSyncMode() || false
            };

            // Set distribution amount based on witness rewards
            if (config.witnessReward > 0) {
                newBlock.dist = BigInt(config.witnessReward).toString()
            }
            logger.debug(`[MINING:prepareBlock] Prepared Echelon block candidate for _id ${newBlock._id}: ${JSON.stringify(newBlock)}`);
            cb(null, newBlock)
        }).catch((error) => {
            logger.error(`[MINING:prepareBlock] Error processing Steem block ${nextSteemBlockNum}:`, error)
            cb(true, null)
        })
    },

    /**
     * Check if this node can mine the next block.
     */
    canMineBlock: (cb: (err: boolean | null, newBlock?: any) => void) => {
        logger.debug('[MINING:canMineBlock] Entered.');
        if (chain.shuttingDown) {
            logger.warn('[MINING:canMineBlock] Chain shutting down, aborting.');
            cb(true, null); return;
        }
        mining.prepareBlock((err, newBlock) => {
            logger.debug(`[MINING:canMineBlock] prepareBlock result - err: ${err}, newBlock._id: ${newBlock?._id}`);
            if (newBlock === null || newBlock === undefined) {
                cb(true, null); return;
            }
            isValidNewBlock(newBlock, false, false, function (isValid: boolean) {
                logger.debug(`[MINING:canMineBlock] isValidNewBlock for _id ${newBlock._id} result: ${isValid}`);
                if (!isValid) {
                    cb(true, newBlock); return;
                }
                cb(null, newBlock);
            });
        });
    },

    mineBlock: (cb: (err: boolean | null, newBlock?: any) => void) => {
        logger.debug('[MINING:mineBlock] Entered.');
        if (chain.shuttingDown) {
            logger.warn('[MINING:mineBlock] Chain shutting down, aborting.');
            return;
        }
        mining.canMineBlock(function (err, newBlock) {
            logger.debug(`[MINING:mineBlock] canMineBlock result - err: ${err}, newBlock._id: ${newBlock?._id}`);
            if (err) {
                cb(true, newBlock); return;
            }
            // at this point transactions in the pool seem all validated
            // BUT with a different ts and without checking for double spend
            // so we will execute transactions in order and revalidate after each execution
            logger.debug(`[MINING:mineBlock] Before executeBlockTransactions for _id ${newBlock._id}. Initial Txs: ${newBlock.txs?.length}`);
            chain.executeBlockTransactions(newBlock, true, function (validTxs: Transaction[], distributed: string) {
                logger.debug(`[MINING:mineBlock] After executeBlockTransactions for _id ${newBlock._id}. Valid Txs: ${validTxs?.length}, Distributed: ${distributed}`);
                try {
                    cache.rollback()
                    // Assign the executed transactions to the block (fix)
                    newBlock.txs = validTxs;

                    // always record the failure of others
                    if (chain.schedule && chain.schedule.shuffle && chain.schedule.shuffle.length > 0) {
                        const shuffleLength = chain.schedule.shuffle.length;
                        const missedWitnessIndex = (newBlock._id - 1) % shuffleLength;
                        // Ensure the index is valid before accessing, though modulo shuffleLength should guarantee this.
                        if (missedWitnessIndex < shuffleLength && chain.schedule.shuffle[missedWitnessIndex].name !== process.env.STEEM_ACCOUNT) {
                            newBlock.missedBy = chain.schedule.shuffle[missedWitnessIndex].name;
                        }
                    } else {
                        logger.warn(`[MINING:mineBlock] Witness schedule not available or shuffle array empty when trying to set missedBy for block ${newBlock._id}.`);
                    }

                    if (distributed) newBlock.dist = distributed;

                    logger.debug(`[MINING:mineBlock] Before hashAndSignBlock for _id ${newBlock._id}.`);
                    newBlock = hashAndSignBlock(newBlock);
                    logger.debug(`[MINING:mineBlock] After hashAndSignBlock for _id ${newBlock._id}. Hash: ${newBlock.hash}`);

                    // Add this check before proposing to consensus
                    if (newBlock.phash !== chain.getLatestBlock().hash) {
                        logger.warn(`[MINING] Chain advanced while preparing block ${newBlock._id}. Own block is stale. Aborting mining attempt for ${process.env.STEEM_ACCOUNT}.`);
                        cb(true, newBlock); // Indicate an error/stale block
                        return;
                    }
                    // End of added check

                    let possBlock: any = {
                        block: newBlock
                    };
                    for (let r = 0; r < config.consensusRounds; r++)
                        possBlock[r] = [];

                    logger.debug(`[MINING:mineBlock] Proposing block _id ${newBlock._id} to consensus. Witness: ${process.env.STEEM_ACCOUNT}`);
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

    minerWorker: (block: Block): void => {
        logger.debug(`[MINING:minerWorker] Entered. Current chain head _id: ${block._id}. p2p.recovering: ${p2p.recovering}`);
        if (p2p.recovering) return;
        clearTimeout(chain.worker);

        if (!chain.schedule || !chain.schedule.shuffle || chain.schedule.shuffle.length === 0) {
            logger.fatal('Witness schedule not available or empty. Chain might be over or not initialized.');
            return;
        }

        const shuffleLength = chain.schedule.shuffle.length;
        // It's highly unlikely shuffleLength would be 0 here due to the check above, 
        // but being absolutely defensive in case chain.schedule.shuffle is an empty array from a faulty witnessModule.witnessSchedule
        if (shuffleLength === 0) {
            logger.fatal('Witness schedule shuffle length is 0 despite earlier checks. Aborting minerWorker.');
            return;
        }

        let mineInMs = null;
        let blockTime = steem.isInSyncMode() ? config.syncBlockTime : config.blockTime;

        const currentTime = new Date().getTime();
        const lastBlockTimestamp = block.timestamp;
        const lastSyncExitTime = steem.getLastSyncExitTime() || 0;
        const justExitedSync = !steem.isInSyncMode() && (currentTime - lastSyncExitTime < (config.blockTime * 2));

        const nextBlockId = block._id + 1;
        // Use shuffleLength for modulo to prevent out-of-bounds access
        const witnessIndex = (nextBlockId - 1) % shuffleLength;
        const primaryWitnessForNextBlock = chain.schedule.shuffle[witnessIndex].name;
        const thisNodeIsPrimaryWitness = primaryWitnessForNextBlock === process.env.STEEM_ACCOUNT;

        if (thisNodeIsPrimaryWitness && chain.lastWriteWasSlow) {
            logger.warn(`[MINING:minerWorker] Previous cache write was slow. This node (${process.env.STEEM_ACCOUNT}) is primary for next block ${nextBlockId}. Forcing a delay to allow backups.`);
            mineInMs = -blockTime;
            chain.lastWriteWasSlow = false;
            logger.info(`[MINING:minerWorker] Self-throttle applied: mineInMs set to ${mineInMs} for block ${nextBlockId}.`);
        }

        if (thisNodeIsPrimaryWitness && mineInMs === null) {
            if (justExitedSync) {
                const targetTimestamp = lastBlockTimestamp + config.blockTime;
                mineInMs = targetTimestamp - currentTime;
                logger.debug(`[MINING:minerWorker] Post-sync transition: Scheduled as next witness. Target: ${new Date(targetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
            } else {
                mineInMs = blockTime;
            }
        }
        else if (mineInMs === null) {
            for (let i = 1; i < 2 * config.witnesses; i++) {
                const recentBlockIndex = chain.recentBlocks.length - i;
                if (recentBlockIndex >= 0 && chain.recentBlocks[recentBlockIndex].witness === process.env.STEEM_ACCOUNT) {
                    if (justExitedSync) {
                        const targetTimestamp = lastBlockTimestamp + (config.blockTime * (i + 1));
                        mineInMs = targetTimestamp - currentTime;
                        logger.debug(`[MINING:minerWorker] Post-sync transition: Backup witness (slot ${i + 1}). Target: ${new Date(targetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
                    } else {
                        mineInMs = blockTime * (i + 1);
                    }
                    logger.debug(`[MINING:minerWorker] Scheduled as backup witness (slot ${i + 1}). Initial mineInMs: ${mineInMs}ms`);
                    break;
                }
            }
        }

        if (mineInMs !== null) {
            mineInMs -= (new Date().getTime() - block.timestamp);
            mineInMs += 40;
            const timeSinceLastBlock = chain.lastBlockTime ? Date.now() - chain.lastBlockTime : 0;
            chain.lastBlockTime = Date.now();
            logger.debug(`[MINING:minerWorker] Calculated mineInMs: ${mineInMs}. Will try to mine for block _id ${block._id + 1}. (sync: ${steem.isInSyncMode()}), timeSinceLastBlock: ${timeSinceLastBlock}ms`);
            consensus.observer = false;

            if (steem.isInSyncMode()) {
                const syncSkipThreshold = Math.max(20, blockTime / 100);
                if (mineInMs < syncSkipThreshold) {
                    const newCalculatedDelay = Math.max(50, Math.floor(blockTime / 4));
                    logger.warn(`[MINING:minerWorker] In Sync: mineInMs (${mineInMs}ms) is below threshold (${syncSkipThreshold}ms). Calculated new delay: ${newCalculatedDelay}ms. Scheduling to mine then.`);
                    mineInMs = newCalculatedDelay;
                }
            } else {
                const postSyncGracePeriod = (config.blockTime || 3000) * 10;
                if (chain.lastWriteWasSlow) {
                    logger.warn('[MINING:minerWorker] Post-block-add check: lastWriteWasSlow is true. Prioritizing network health. Will not mine this slot.');
                    return;
                }
                if (lastSyncExitTime && (currentTime - lastSyncExitTime < postSyncGracePeriod)) {
                    const lenientSkipThreshold = Math.max(100, blockTime / 10);
                    if (mineInMs < lenientSkipThreshold) {
                        logger.warn(`[MINING:minerWorker] Post-sync Grace Period: mineInMs (${mineInMs}ms) is below lenient threshold (${lenientSkipThreshold}ms). Waiting for chain head to advance.`);
                        // Only retry if chain head advances
                        const currentBlockId = block._id;
                        const waitForAdvance = () => {
                            const latestBlock = chain.getLatestBlock();
                            if (latestBlock && latestBlock._id > currentBlockId) {
                                mining.minerWorker(latestBlock);
                            } else {
                                setTimeout(waitForAdvance, 1000);
                            }
                        };
                        setTimeout(waitForAdvance, 1000);
                        return;
                    }
                } else {
                    const normalSkipThreshold = Math.max(150, blockTime / 3);
                    logger.debug(`[MINING:minerWorker] Normal Mode: mineInMs (${mineInMs}ms) is above threshold (${normalSkipThreshold}ms). Proceeding to mine.`);
                    if (mineInMs < normalSkipThreshold) {
                        logger.warn(`[MINING:minerWorker] Normal Mode: mineInMs (${mineInMs}ms) is below threshold (${normalSkipThreshold}ms). Waiting for chain head to advance.`);
                        const waitForAdvance = () => {
                            const latestBlock = chain.getLatestBlock();
                            steem.getLatestSteemBlockNum().then(latestSteemBlock => {
                                logger.warn(`[MINING:minerWorker] Normal Mode: latestBlock (${latestSteemBlock})`);
                                if (latestSteemBlock) {
                                    console.log(`Waiting for steem chain head to advance: latestBlock=${latestBlock?.steemBlockNum}, latestSteemBlock=${latestSteemBlock}`);
                                    if (latestBlock && latestBlock.steemBlockNum < latestSteemBlock) {
                                        mining.mineBlock(function (error, finalBlock) {
                                            if (error) {
                                                logger.warn(`[MINING:minerWorker] mineBlock callback error for ${block._id + 1}. finalBlock._id: ${finalBlock?._id}`, error);
                                            }
                                        });
                                    } else {
                                        setTimeout(waitForAdvance, 3000);
                                    }
                                } else {
                                    // Handle null response - keep retrying to get Steem block instead of stopping
                                    logger.warn('[MINING:minerWorker] Could not get latest Steem block, retrying...');
                                    setTimeout(waitForAdvance, 5000);
                                }
                            }).catch(error => {
                                logger.error('[MINING:minerWorker] Error getting latest Steem block:', error);
                                // Keep retrying on error instead of stopping
                                setTimeout(waitForAdvance, 5000);
                            });
                        };
                        setTimeout(waitForAdvance, 3000);
                        return;
                    }
                }
            }


            chain.worker = setTimeout(function () {
                mining.mineBlock(function (error, finalBlock) {
                    if (error) {
                        logger.warn(`[MINING:minerWorker] mineBlock callback error for ${block._id + 1}. finalBlock._id: ${finalBlock?._id}`, error);
                    }
                });
            }, mineInMs);
        }
    },
};

export default mining; 