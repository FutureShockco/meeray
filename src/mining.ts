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
const bs58 = baseX(config.b58Alphabet);

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
                dist: 0,
                sync: steem.isInSyncMode() || false
            };

            // Set distribution amount based on witness rewards
            if (config.witnessReward > 0) {
                newBlock.dist = config.witnessReward
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
        if ((chain as any).shuttingDown) {
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
        if ((chain as any).shuttingDown) {
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
            chain.executeBlockTransactions(newBlock, true, function (validTxs: Transaction[], distributed: number) {
                logger.debug(`[MINING:mineBlock] After executeBlockTransactions for _id ${newBlock._id}. Valid Txs: ${validTxs?.length}, Distributed: ${distributed}`);
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

                    logger.debug(`[MINING:mineBlock] Before hashAndSignBlock for _id ${newBlock._id}.`);
                    newBlock = mining.hashAndSignBlock(newBlock);
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
        if (p2p.recovering) return
        clearTimeout(chain.worker)

        if (chain.schedule.shuffle.length === 0) {
            logger.fatal('All witnesses gave up their stake? Chain is over')
            process.exit(1)
        }

        let mineInMs = null
        // Get the appropriate block time based on sync state
        let blockTime = steem.isInSyncMode()
            ? config.syncBlockTime
            : config.blockTime

        const currentTime = new Date().getTime();
        const lastBlockTimestamp = block.timestamp;
        const lastSyncExitTime = steem.getLastSyncExitTime() || 0;
        const justExitedSync = !steem.isInSyncMode() && (currentTime - lastSyncExitTime < (config.blockTime * 2)); // Check if within ~2 normal block times of exiting sync

        // Log which block time we're using for clarity
        if (steem.isInSyncMode()) {
            logger.debug(`[MINING:minerWorker] Using sync block time: ${blockTime}ms (Currently in sync mode)`);
        } else if (justExitedSync) {
            logger.info(`[MINING:minerWorker] Recently exited sync mode. Ensuring next block respects normal blockTime (${config.blockTime}ms) relative to last block.`);
            // blockTime is already config.blockTime here
        } else {
            logger.debug(`[MINING:minerWorker] Using normal block time: ${blockTime}ms`);
        }

        // if we are the next scheduled witness, try to mine in time
        if (chain.schedule.shuffle[(block._id) % config.witnesses].name === process.env.STEEM_ACCOUNT) {
            if (justExitedSync) {
                // Ensure the first block after sync adheres to the normal blockTime from the *actual* last block's timestamp
                const targetTimestamp = lastBlockTimestamp + config.blockTime; // Normal block time interval
                mineInMs = targetTimestamp - currentTime;
                logger.debug(`[MINING:minerWorker] Post-sync transition: Scheduled as next witness. Target: ${new Date(targetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
            } else {
                mineInMs = blockTime; // Standard calculation if not just exited sync or if still in sync
            }
        }
        // else if the scheduled witnesses miss blocks
        // backups witnesses are available after each block time intervals
        else {
            for (let i = 1; i < 2 * config.witnesses; i++) {
                // Check if this node was the witness for a recent block that might have been missed by others
                // This logic seems to be about becoming a backup witness
                if (chain.recentBlocks[chain.recentBlocks.length - i]
                    && chain.recentBlocks[chain.recentBlocks.length - i].witness === process.env.STEEM_ACCOUNT) {
                    
                    if (justExitedSync) {
                        // If just exited sync and acting as backup, base it on when the missed slot *should have* occurred after last actual block
                        const missedSlotTargetTimestamp = lastBlockTimestamp + ((i + 1) * config.blockTime);
                        mineInMs = missedSlotTargetTimestamp - currentTime;
                        logger.debug(`[MINING:minerWorker] Post-sync transition: Acting as backup for slot ${i+1}. Target: ${new Date(missedSlotTargetTimestamp).toISOString()}. Current: ${new Date(currentTime).toISOString()}. Calculated mineInMs: ${mineInMs}`);
                    } else {
                        mineInMs = (i + 1) * blockTime; // Standard backup calculation
                    }
                    break;
                }
            }
        }

        if (mineInMs !== null) { // Check if mineInMs was set (i.e., it's our turn or a backup slot)
            // Calculate time since last block, accounting for possible clock drift
            const timeSinceLastBlock = currentTime - lastBlockTimestamp;

            if (!justExitedSync) { // For normal operation or sync mode, adjust by timeSinceLastBlock
                 mineInMs -= timeSinceLastBlock;
            }
            // If justExitedSync, mineInMs is already calculated relative to currentTime and target, so no timeSinceLastBlock adjustment needed here.

            // Add a small buffer to avoid clock differences causing delays
            mineInMs += 40;

            logger.debug(`[MINING:minerWorker] Calculated mineInMs: ${mineInMs}. Will try to mine for block _id ${block._id + 1}. (sync: ${steem.isInSyncMode()}), timeSinceLastBlock: ${timeSinceLastBlock}ms`);
            consensus.observer = false

            // Performance check
            if (steem.isInSyncMode()) {
                const syncSkipThreshold = Math.max(20, blockTime / 100); // 1% of syncBlockTime, or 20ms minimum
                if (mineInMs < syncSkipThreshold) {
                    logger.warn(`[MINING:minerWorker] In Sync: mineInMs (${mineInMs}ms) is below threshold (${syncSkipThreshold}ms). Scheduling to mine ASAP.`);
                    mineInMs = 10; // Schedule in 10ms - DO NOT SKIP
                }
            } else { // Normal Mode
                const postSyncGracePeriod = (config as any).postSyncGracePeriodMs || 120000; // Default 2 minutes
                const inPostSyncGrace = steem.getLastSyncExitTime() && (currentTime - (steem.getLastSyncExitTime() || 0) < postSyncGracePeriod);
                const normalModeSkipThreshold = blockTime / 3; // Approx 33% of block time

                if (inPostSyncGrace) {
                    const postSyncCriticalSkipThreshold = blockTime / 10; // 10% of block time
                    const postSyncWarningThreshold = blockTime / 5;   // 20% of block time

                    if (mineInMs < postSyncCriticalSkipThreshold) {
                        logger.warn(`[MINING:minerWorker] Extremely slow post-sync performance (mineInMs: ${mineInMs}ms < critical threshold: ${postSyncCriticalSkipThreshold}ms), skipping block for _id ${block._id + 1}`);
                        return;
                    } else if (mineInMs < postSyncWarningThreshold) {
                        logger.warn(`[MINING:minerWorker] Post-sync performance issue detected (mineInMs: ${mineInMs}ms < warning threshold: ${postSyncWarningThreshold}ms), continuing to mine but logging.`);
                        // No skip, proceed to mine
                    }
                } else { // Standard normal mode (not in post-sync grace)
                    if (mineInMs < normalModeSkipThreshold) {
                        logger.warn(`[MINING:minerWorker] Slow performance detected in normal mode (mineInMs: ${mineInMs}ms < threshold: ${normalModeSkipThreshold.toFixed(0)}ms), will not try to mine block for _id ${block._id + 1}`);
                        return;
                    }
                }
            }

            // Make sure the node is marked as ready to receive transactions now that we're mining
            if (steem && steem.setReadyToReceiveTransactions)
                steem.setReadyToReceiveTransactions(true)

            logger.debug(`[MINING:minerWorker] Scheduling mineBlock call in ${mineInMs}ms.`);
            chain.worker = setTimeout(function () {
                logger.debug('[MINING:minerWorker] setTimeout triggered, calling mineBlock.');
                mining.mineBlock(function (error, finalBlock) {
                    if (error)
                        logger.warn(`Error mining block. finalBlock._id: ${finalBlock?._id}`, finalBlock ? '' : '(No block object)');
                    else
                        logger.debug(` Successfully processed/proposed block. finalBlock._id: ${finalBlock?._id}`);
                })
            }, mineInMs)
        }
    },
    hashAndSignBlock: (block: Block): Block => {
        let nextHash = calculateHashForBlock(block)
        let sigObj = secp256k1.ecdsaSign(Buffer.from(nextHash, 'hex'), bs58.decode(process.env.WITNESS_PRIVATE_KEY || ''))
        const signature = bs58.encode(sigObj.signature)
        block.signature = signature
        block.hash = nextHash
        return block
    },
};

export default mining; 