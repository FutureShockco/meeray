import { chain } from './chain.js';
import { Block, isValidNewBlock } from './block.js';
import config from './config.js';
import transaction from './transaction.js';
import logger from './logger.js';
import steem from './steem.js';
import { Transaction } from './transactions/index.js';
import cache from './cache.js';
import consensus from './consensus.js';
import p2p from './p2p/index.js';
import { hashAndSignBlock } from './crypto.js';

export const mining = {

    prepareBlock: async (cb: (err: any, newBlock?: any) => void) => {
        let previousBlock = chain.getLatestBlock();
        if (!previousBlock) {
            logger.error('[MINING:prepareBlock] Cannot get latest block from chain. Aborting.');
            cb(true, null);
            return;
        }
        let nextIndex = previousBlock._id + 1;
        const targetBlockInterval = steem.isInSyncMode() ? config.syncBlockTime : config.blockTime;
        const minTimestampForNewBlock = previousBlock.timestamp + targetBlockInterval;
        const currentSystemTime = new Date().getTime();
        let nextTimestamp = Math.max(currentSystemTime, minTimestampForNewBlock);
        let nextSteemBlockNum = previousBlock.steemBlockNum + 1;
        let nextSteemBlockTimestamp = previousBlock.steemBlockTimestamp + targetBlockInterval; // Approximate, actual comes from Steem block

        logger.trace(`prepareBlock: Mode: ${steem.isInSyncMode() ? 'SYNC' : 'NORMAL'}, TargetInterval: ${targetBlockInterval}ms`);

        try {
            // Wait for Steem block processing to complete - this is BLOCKING
            const transactions = await steem.processBlock(nextSteemBlockNum);
            
            if (!transactions) {
                // Handle the case where the Steem block doesn't exist yet
                if (steem.getBehindBlocks() <= 0) {
                    logger.trace(`prepareBlock: Steem block ${nextSteemBlockNum} not found, but caught up. Retrying.`);
                    // If we're at the head of Steem, wait a bit and let the caller retry
                    setTimeout(() => {
                        cb(true, null)
                    }, 1000)
                    return;
                }

                logger.warn(`prepareBlock: Steem block ${nextSteemBlockNum} not found, behind by ${steem.getBehindBlocks()} blocks. Cannot prepare Echelon block.`);
                cb(true, null)
                return;
            }
            logger.trace(`prepareBlock: Successfully processed Steem block ${nextSteemBlockNum}. Transactions found: ${transactions.transactions.length}`);

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

            logger.trace(`prepareBlock: Added ${txs.length} transactions from mempool.`);

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
            logger.trace(`prepareBlock: Prepared block candidate for _id ${newBlock._id}: ${JSON.stringify(newBlock)}`);
            cb(null, newBlock)
        } catch (error) {
            logger.error(`prepareBlock: Error processing Steem block ${nextSteemBlockNum}:`, error)
            cb(true, null)
        }
    },

    canMineBlock: async (cb: (err: boolean | null, newBlock?: any) => void) => {
        if (chain.shuttingDown) {
            logger.warn('canMineBlock: Chain shutting down, aborting.');
            cb(true, null); return;
        }
        mining.prepareBlock(async (err, newBlock) => {
            logger.trace(`canMineBlock: prepareBlock result - err: ${err}, newBlock._id: ${newBlock?._id}`);
            if (newBlock === null || newBlock === undefined) {
                cb(true, null); return;
            }
            const isValid = await isValidNewBlock(newBlock, false, false);
            logger.trace(`canMineBlock: isValidNewBlock for _id ${newBlock._id} result: ${isValid}`);
            if (!isValid) {
                cb(true, newBlock); return;
            }
            cb(null, newBlock);
        });

    },

    mineBlock: (cb: (err: boolean | null, newBlock?: any) => void) => {
        if (chain.shuttingDown) {
            logger.warn('mineBlock: Chain shutting down, aborting.');
            return;
        }
        mining.canMineBlock(function (err, newBlock) {
            logger.trace(`mineBlock: canMineBlock: result - err: ${err}, newBlock._id: ${newBlock?._id}`);
            if (err) {
                cb(true, newBlock); return;
            }

            logger.trace(`mineBlock: Before executeBlockTransactions for _id ${newBlock._id}. Initial Txs: ${newBlock.txs?.length}`);
            chain.executeBlockTransactions(newBlock, true, function (validTxs: Transaction[], distributed: string) {
                logger.trace(`mineBlock: After executeBlockTransactions for _id ${newBlock._id}. Valid Txs: ${validTxs?.length}, Distributed: ${distributed}`);
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
                        logger.warn(`mineBlock: Witness schedule not available or shuffle array empty when trying to set missedBy for block ${newBlock._id}.`);
                    }

                    if (distributed) newBlock.dist = distributed;

                    newBlock = hashAndSignBlock(newBlock);

                    if (newBlock.phash !== chain.getLatestBlock().hash) {
                        logger.warn(`mineBlock: Chain advanced while preparing block ${newBlock._id}. Own block is stale. Aborting mining attempt for ${process.env.STEEM_ACCOUNT}.`);
                        cb(true, newBlock);
                        return;
                    }

                    let possBlock: any = {
                        block: newBlock
                    };
                    for (let r = 0; r < config.consensusRounds; r++)
                        possBlock[r] = [];

                    logger.trace(`mineBlock: Proposing block _id ${newBlock._id} to consensus. Witness: ${process.env.STEEM_ACCOUNT}`);
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
        logger.trace(`minerWorker: Entered. Current chain head _id: ${block._id}. p2p.recovering: ${p2p.recovering}`);
        if (p2p.recovering) {
            // Don't mark as mining attempt if we're in recovery mode
            logger.debug('minerWorker: Skipping mining - node in recovery mode');
            return;
        }
        
        // Check if we have sufficient peers for consensus before mining
        const connectedPeerCount = p2p.sockets.filter(s => s.node_status).length;
        const currentNodeIsWitness = consensus.isActive();
        const currentPeerCount = connectedPeerCount + (currentNodeIsWitness ? 1 : 0);
        const totalWitnesses = config.witnesses || 5;
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
        
        // If we're in sync mode but below consensus threshold, exit sync mode
        if (steem.isInSyncMode() && currentPeerCount < minPeersForConsensus) {
            logger.warn(`[SYNC-EXIT] Below consensus threshold (${currentPeerCount}/${minPeersForConsensus}) while in sync mode. Forcing sync mode exit.`);
            const currentBlock = chain.getLatestBlock();
            steem.exitSyncMode(currentBlock._id, currentBlock.steemBlockNum || 0);
            // Continue with normal mining logic below
        }
        
        if (currentPeerCount < minPeersForConsensus && consensus.isActive()) {
            logger.warn(`[MINING] Insufficient peers for consensus (${currentPeerCount}/${minPeersForConsensus}). Delaying mining for block ${block._id + 1}`);
            // Retry mining after a short delay, giving time for peer discovery to work
            chain.worker = setTimeout(() => {
                const newLatestBlock = chain.getLatestBlock();
                // Only retry if the chain hasn't advanced (no one else mined this block)
                if (newLatestBlock._id === block._id) {
                    mining.minerWorker(block);
                } else {
                    // Chain advanced, start mining the new latest block
                    mining.minerWorker(newLatestBlock);
                }
            }, 3000);
            logger.debug('minerWorker: Insufficient peers, delaying mining (no tracking needed)');
            return;
        }
        
        // Clear existing mining timeout
        clearTimeout(chain.worker);
        chain.worker = null;

        // Prevent duplicate mining attempts for the same block height
        const candidateBlockId = block._id + 1;
        
        // Initialize mining tracking if not exists
        if (!(chain as any).activeMiningAttempts) {
            (chain as any).activeMiningAttempts = new Set();
        }
        
        // Auto-cleanup completed/failed mining attempts
        const cleanupMiningAttempt = () => {
            (chain as any).activeMiningAttempts.delete(candidateBlockId);
            logger.debug(`minerWorker: Cleaned up mining attempt for block ${candidateBlockId}`);
        };
        
        // Cleanup after reasonable timeout
        const cleanupTimeout = setTimeout(cleanupMiningAttempt, (steem.isInSyncMode() ? config.syncBlockTime : config.blockTime) * 3);
        
        // Helper function for early returns that need cleanup
        const abortMining = (reason: string) => {
            cleanupMiningAttempt();
            clearTimeout(cleanupTimeout);
            logger.warn(`minerWorker: Aborting mining for block ${candidateBlockId}: ${reason}`);
        };
        
        // Check if already mining this block
        if ((chain as any).activeMiningAttempts.has(candidateBlockId)) {
            logger.warn(`minerWorker: Already actively mining block ${candidateBlockId}, skipping duplicate attempt`);
            // Don't call abortMining here since the attempt is already tracked
            return;
        }
        
        
        // Mark as actively mining
        (chain as any).activeMiningAttempts.add(candidateBlockId);
        logger.debug(`minerWorker: Starting mining attempt for block ${candidateBlockId}`);

        if (!chain.schedule || !chain.schedule.shuffle || chain.schedule.shuffle.length === 0) {
            logger.fatal('Witness schedule not available or empty. Chain might be over or not initialized.');
            abortMining('No witness schedule');
            return;
        }

        const shuffleLength = chain.schedule.shuffle.length;
        // It's highly unlikely shuffleLength would be 0 here due to the check above, 
        // but being absolutely defensive in case chain.schedule.shuffle is an empty array from a faulty witnessModule.witnessSchedule
        if (shuffleLength === 0) {
            logger.fatal('Witness schedule shuffle length is 0 despite earlier checks. Aborting minerWorker.');
            abortMining('Empty witness shuffle');
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
            logger.warn(`minerWorker: Previous cache write was slow. This node (${process.env.STEEM_ACCOUNT}) is primary for next block ${nextBlockId}. Forcing a delay to allow backups.`);
            mineInMs = blockTime * 2; // Delay primary to give backups a chance (positive delay)
            chain.lastWriteWasSlow = false;
            logger.trace(`minerWorker: Self-throttle applied: mineInMs set to ${mineInMs} for block ${nextBlockId}.`);
        }

        if (thisNodeIsPrimaryWitness && mineInMs === null) {
            if (justExitedSync) {
                const targetTimestamp = lastBlockTimestamp + config.blockTime;
                mineInMs = targetTimestamp - currentTime;
                logger.trace(`minerWorker: Post-sync transition: Scheduled as next witness. Target: ${new Date(targetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
            } else {
                mineInMs = blockTime;
            }
        }
        else if (mineInMs === null) {
            // Universal backup: Any active witness can backup after primary witness time
            // Check if this witness is in the current shuffle (active witnesses)
            let isActiveWitness = false;
            let backupSlot = 0;
            
            for (let i = 0; i < chain.schedule.shuffle.length; i++) {
                if (chain.schedule.shuffle[i].name === process.env.STEEM_ACCOUNT) {
                    isActiveWitness = true;
                    // Calculate backup slot based on witness position in shuffle
                    // Primary witness gets slot 0, others get slots 1, 2, 3...
                    const primaryWitnessIndex = (nextBlockId - 1) % chain.schedule.shuffle.length;
                    backupSlot = (i - primaryWitnessIndex + chain.schedule.shuffle.length) % chain.schedule.shuffle.length;
                    if (backupSlot === 0) backupSlot = chain.schedule.shuffle.length; // Primary becomes last backup
                    break;
                }
            }
            
            if (isActiveWitness && backupSlot > 0) {
                if (justExitedSync) {
                    const targetTimestamp = lastBlockTimestamp + (config.blockTime * (1 + (backupSlot * 0.5)) + (config.blockTime / 2));
                    mineInMs = targetTimestamp - currentTime;
                    logger.trace(`minerWorker: Post-sync transition: Backup witness (slot ${backupSlot}). Target: ${new Date(targetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
                } else {
                    mineInMs = blockTime * (1 + (backupSlot * 0.5));
                }
                logger.debug(`minerWorker: Scheduled as backup witness (slot ${backupSlot}). Initial mineInMs: ${mineInMs}ms (${1 + (backupSlot * 0.5)}x blockTime)`);
            }
        }

        if (mineInMs !== null) {
            mineInMs -= (new Date().getTime() - block.timestamp);
            // Add larger buffer for backup witnesses to account for processing delays
            const bufferMs = thisNodeIsPrimaryWitness ? 40 : 200; // 200ms buffer for backups
            mineInMs += bufferMs;
            const timeSinceLastBlock = chain.lastBlockTime ? Date.now() - chain.lastBlockTime : 0;
            chain.lastBlockTime = Date.now();
            logger.trace(`minerWorker: Calculated mineInMs: ${mineInMs}. Will try to mine for block _id ${block._id + 1}. (sync: ${steem.isInSyncMode()}), timeSinceLastBlock: ${timeSinceLastBlock}ms`);
            consensus.observer = false;

            if (steem.isInSyncMode()) {
                const syncSkipThreshold = Math.max(20, blockTime / 100);
                if (mineInMs < syncSkipThreshold) {
                    const newCalculatedDelay = Math.max(50, Math.floor(blockTime / 4));
                    logger.warn(`minerWorker: In Sync: mineInMs (${mineInMs}ms) is below threshold (${syncSkipThreshold}ms). Calculated new delay: ${newCalculatedDelay}ms. Scheduling to mine then.`);
                    mineInMs = newCalculatedDelay;
                }
            } else {
                const postSyncGracePeriod = (config.blockTime || 3000) * 10;
                if (chain.lastWriteWasSlow) {
                    logger.warn('minerWorker: Post-block-add check: lastWriteWasSlow is true. Prioritizing network health. Will not mine this slot.');
                    abortMining('Network health - slow write detected');
                    return;
                }
                if (lastSyncExitTime && (currentTime - lastSyncExitTime < postSyncGracePeriod)) {
                    const lenientSkipThreshold = Math.max(100, blockTime / 10);
                    if (mineInMs < lenientSkipThreshold) {
                        logger.warn(`minerWorker: Post-sync Grace Period: mineInMs (${mineInMs}ms) is below lenient threshold (${lenientSkipThreshold}ms). Waiting for chain head to advance.`);
                        // Only retry if chain head advances
                        const currentBlockId = block._id;
                        const waitForAdvance = () => {
                            const latestBlock = chain.getLatestBlock();
                            if (latestBlock && latestBlock._id > currentBlockId) {
                                // Reset the mining attempt flag before calling minerWorker to allow new block
                                (chain as any).lastMiningAttemptBlockId = null;
                                mining.minerWorker(latestBlock);
                            } else {
                                setTimeout(waitForAdvance, 1000);
                            }
                        };
                        setTimeout(waitForAdvance, 1000);
                        abortMining('Post-sync grace period - timing too compressed');
                        return;
                    }
                } else {
                    const normalSkipThreshold = config.blockTime / 2;
                    logger.debug(`minerWorker: Normal Mode: mineInMs (${mineInMs}ms) vs threshold (${normalSkipThreshold}ms)`);
                    if (mineInMs < normalSkipThreshold) {
                        logger.warn(`minerWorker: Normal Mode: mineInMs (${mineInMs}ms) is below threshold (${normalSkipThreshold}ms). Waiting for chain head to advance.`);
                        const waitForAdvance = () => {
                            const latestBlock = chain.getLatestBlock();
                            steem.getLatestSteemBlockNum().then(latestSteemBlock => {
                                logger.warn(`minerWorker: Normal Mode: latestBlock (${latestSteemBlock})`);
                                if (latestSteemBlock) {
                                    logger.warn(`Waiting for steem chain head to advance: latestBlock=${latestBlock?.steemBlockNum}, latestSteemBlock=${latestSteemBlock}`);
                                    if (latestBlock && latestBlock.steemBlockNum < latestSteemBlock) {
                                        mining.mineBlock(function (error, finalBlock) {
                                            if (error) {
                                                logger.warn(`minerWorker: mineBlock: callback error for ${block._id + 1}. finalBlock._id: ${finalBlock?._id}`, error);
                                            }
                                        });
                                    } else {
                                        setTimeout(waitForAdvance, 3000);
                                    }
                                } else {
                                    // Handle null response - keep retrying to get Steem block instead of stopping
                                    logger.warn('minerWorker: Could not get latest Steem block, retrying...');
                                    setTimeout(waitForAdvance, 5000);
                                }
                            }).catch(error => {
                                logger.error('minerWorker: Error getting latest Steem block:', error);
                                // Keep retrying on error instead of stopping
                                setTimeout(waitForAdvance, 5000);
                            });
                        };
                        setTimeout(waitForAdvance, 3000);
                        abortMining('Normal mode - timing too compressed');
                        return;
                    }
                }
            }


            chain.worker = setTimeout(function () {
                mining.mineBlock(function (error, finalBlock) {
                    // Clean up mining attempt when done (success or failure)
                    const minedBlockId = block._id + 1;
                    if ((chain as any).activeMiningAttempts) {
                        (chain as any).activeMiningAttempts.delete(minedBlockId);
                        logger.debug(`minerWorker: Mining completed for block ${minedBlockId}, cleaned up mining attempt`);
                    }
                    clearTimeout(cleanupTimeout); // Cancel auto-cleanup since we're doing it now
                    
                    if (error) {
                        logger.warn(`minerWorker: mineBlock: callback error for ${minedBlockId}. finalBlock._id: ${finalBlock?._id}`, error);
                    } else {
                        logger.debug(`minerWorker: Successfully mined block ${minedBlockId}`);
                    }
                });
            }, mineInMs);
        }
    },
};

export default mining; 