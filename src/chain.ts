import series from 'run-series';

import { upsertAccountsReferencedInTx } from './account.js';
import { Block, isValidNewBlock } from './block.js';
import { blocks } from './blockStore.js';
import cache from './cache.js';
import config from './config.js';
import logger from './logger.js';
import mining from './mining.js';
import notifications from './modules/notifications.js';
import txHistory from './modules/txHistory.js';
import mongo from './mongo.js';
import p2p from './p2p/index.js';
import settings from './settings.js';
import steem from './steem.js';
import transaction from './transaction.js';
import { Transaction } from './transactions/index.js';
import { toBigInt } from './utils/bigint.js';
import { witnessesModule } from './witnesses.js';
import witnessesStats from './witnessesStats.js';

const SYNC_MODE_BROADCAST_INTERVAL_BLOCKS = 3;
const NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS = 6;
const REPLAY_OUTPUT = process.env.REPLAY_OUTPUT ? parseInt(process.env.REPLAY_OUTPUT) : 1000;

export const chain = {
    blocksToRebuild: [] as any[],
    restoredBlocks: 0,
    schedule: null as any,
    recentBlocks: [] as any[],
    recentTxs: {} as Record<string, any>,
    nextOutput: { txs: 0, dist: '0' },
    lastRebuildOutput: 0,
    worker: null as any,
    shuttingDown: false,
    latestSteemBlock: 0,
    lastBlockTime: 0,
    alternativeBlocks: [] as any[],

    getGenesisBlock: () => {
        const genesisBlock: Block = {
            _id: 0,
            blockNum: 0,
            steemBlockNum: config.steemStartBlock,
            steemBlockTimestamp: 0,
            phash: '0',
            timestamp: 0,
            txs: [],
            witness: config.masterName,
            missedBy: '',
            dist: '0',
            sync: false,
            signature: '0000000000000000000000000000000000000000000000000000000000000000',
            hash: config.originHash,
        };
        return genesisBlock;
    },

    getLatestBlock: () => {
        return chain.recentBlocks[chain.recentBlocks.length - 1] || chain.getGenesisBlock();
    },

    getFirstMemoryBlock: () => {
        return chain.recentBlocks[0];
    },

    addRecentTxsInBlock: (txs: any[] = []) => {
        for (const t in txs) chain.recentTxs[txs[t].hash] = txs[t];
    },

    cleanMemory: () => {
        chain.cleanMemoryBlocks();
        chain.cleanMemoryTx();
    },

    cleanMemoryBlocks: () => {
        let extraBlocks = chain.recentBlocks.length - (config.memoryBlocks || 10000);
        while (extraBlocks > 0) {
            chain.recentBlocks.shift();
            extraBlocks--;
        }
    },

    cleanMemoryTx: () => {
        for (const hash in chain.recentTxs)
            if (chain.recentTxs[hash].ts + (config.txExpirationTime || 3600000) < chain.getLatestBlock().timestamp) delete chain.recentTxs[hash];
    },

    output: async (block: any, rebuilding?: boolean) => {
        chain.nextOutput.txs += block.txs.length;
        if (block.dist) chain.nextOutput.dist = (toBigInt(chain.nextOutput.dist) + toBigInt(block.dist)).toString();

        const currentOutTime = new Date().getTime();
        let outputLog = '';
        if (rebuilding) outputLog += 'Rebuilt ';
        outputLog += '#' + block._id;
        if (rebuilding) outputLog += '/' + chain.restoredBlocks;
        else outputLog += '  by ' + block.witness;
        outputLog += '  ' + chain.nextOutput.txs + ' tx';
        if (chain.nextOutput.txs > 1) outputLog += 's';
        const distInNativeToken = Number(chain.nextOutput.dist) / Math.pow(10, config.nativeTokenPrecision);
        outputLog += '  steemBlockNum: ' + block.steemBlockNum;
        outputLog += '  dist: ' + distInNativeToken + ' ' + config.nativeTokenSymbol;
        outputLog += '  delay: ' + (currentOutTime - block.timestamp);
        if (block.missedBy && !rebuilding) outputLog += '  MISS: ' + block.missedBy;
        if (!rebuilding && !p2p.recovering) {
            const checkInterval = steem.isInSyncMode() ? SYNC_MODE_BROADCAST_INTERVAL_BLOCKS : NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS;
            if (steem.isInSyncMode() || block._id % checkInterval === 0) {
                try {
                    const currentSteemHead = await steem.getLatestSteemBlockNum();
                    const ourLastProcessedSteemBlock = block.steemBlockNum;
                    if (currentSteemHead && ourLastProcessedSteemBlock) {
                        const localSteemDelayCorrected = Math.max(0, currentSteemHead - ourLastProcessedSteemBlock);
                        steem.updateLocalSteemState(localSteemDelayCorrected, currentSteemHead); // Inform steem.ts of local lag
                        const networkOverall = steem.getNetworkOverallBehindBlocks();
                        if (steem.isInSyncMode()) {
                            outputLog += ' (SYNCING - ';
                            if (localSteemDelayCorrected > 0) {
                                outputLog += `${localSteemDelayCorrected} blocks behind Steem`;

                                const processingRate = 1; // blocks per second in sync mode
                                const steemProductionRate = 1 / 3; // Steem blocks per second
                                const netCatchupRate = processingRate - steemProductionRate;

                                if (netCatchupRate > 0) {
                                    const secondsToSync = Math.ceil(localSteemDelayCorrected / netCatchupRate);
                                    const minutesToSync = Math.ceil(secondsToSync / 60);

                                    if (minutesToSync < 2) {
                                        outputLog += ` ~${secondsToSync}s to sync`;
                                    } else if (minutesToSync < 120) {
                                        outputLog += ` ~${minutesToSync}m to sync`;
                                    } else {
                                        const hoursToSync = Math.floor(minutesToSync / 60);
                                        const remainingMinutes = minutesToSync % 60;
                                        outputLog += ` ~${hoursToSync}h ${remainingMinutes}m to sync`;
                                    }
                                } else {
                                    outputLog += ' - catch-up rate non-positive';
                                }
                            } else {
                                outputLog += 'Caught up with Steem';
                            }
                            outputLog += ')';

                            if (await steem.shouldExitSyncMode(block._id)) {
                                logger.info(
                                    `CONDITIONS MET TO EXIT SYNC MODE. Local delay: ${localSteemDelayCorrected}. Network consensus for exit is YES. Attempting exit.`
                                );
                                steem.exitSyncMode(block._id, currentSteemHead); // Pass current Steem head
                                outputLog += ' (Exiting Sync Mode)';
                            } else {
                                // logger.info(`Still in SYNC MODE. Local delay: ${localSteemDelayCorrected}. Network consensus for exit is NO.`);
                            }
                        } else {
                            // Not in sync mode
                            // Evaluate entry conditions
                            const criticalLocalDelayThreshold = config.steemBlockMaxDelay || 10;
                            const networkMedianEntryThreshold = config.steemBlockMaxDelay || Math.max(10, (config.steemBlockDelay || 10) * 1.5);
                            const witnessLagThreshold = config.steemBlockMaxDelay || config.steemBlockDelay || 10;

                            const activeWitnessAccounts = chain.schedule?.active_witnesses || config.witnesses || [];
                            const minWitnessesLaggingForEntryFactor =
                                activeWitnessAccounts.length > 0 ? Math.max(1, Math.ceil(activeWitnessAccounts.length * 0.3)) : 0;

                            const isLocallyCritical = localSteemDelayCorrected > criticalLocalDelayThreshold;
                            const isNetworkMedianLagHigh = networkOverall.medianBehind > networkMedianEntryThreshold;
                            const areEnoughWitnessesLagging =
                                activeWitnessAccounts.length > 0 && networkOverall.witnessesBehindThreshold >= minWitnessesLaggingForEntryFactor;

                            let entryReason = '';
                            if (isLocallyCritical) entryReason += 'Local node critically lagging. ';
                            if (isNetworkMedianLagHigh) entryReason += 'Network median Steem lag high. ';
                            if (areEnoughWitnessesLagging) entryReason += 'Sufficient active witnesses lagging. ';

                            if (isLocallyCritical || isNetworkMedianLagHigh || areEnoughWitnessesLagging) {
                                logger.info(
                                    `Primary condition(s) for sync mode met: ${entryReason}Local Lag: ${localSteemDelayCorrected}, Network Median: ${networkOverall.medianBehind}, Reporting Witnesses Lagging: ${networkOverall.witnessesBehindThreshold}/${minWitnessesLaggingForEntryFactor} (threshold: >${witnessLagThreshold}).`
                                );
                                if (steem.isNetworkReadyToEnterSyncMode(localSteemDelayCorrected, steem.isInSyncMode())) {
                                    logger.info('Network IS ready for coordinated sync mode entry. Attempting entry.');
                                    steem.enterSyncMode();
                                    outputLog += ` (Entering Sync - Lag: ${localSteemDelayCorrected}, NetMedLag: ${networkOverall.medianBehind})`;
                                } else {
                                    logger.info('Network is NOT YET ready for coordinated sync mode entry (quorum pending).');
                                    outputLog += ` (Sync entry pending quorum - Lag: ${localSteemDelayCorrected}, NetMedLag: ${networkOverall.medianBehind})`;
                                }
                            } else {
                                outputLog += ` (NORMAL - Lag: ${localSteemDelayCorrected}, NetMedLag: ${networkOverall.medianBehind})`;
                            }
                        }
                    } else {
                        logger.warn('Could not get currentSteemHead or ourLastProcessedSteemBlock for sync decision in chain.output.');
                        outputLog += ' (Sync check skipped - missing Steem data)';
                    }
                } catch (error) {
                    logger.error('Error in sync mode decision logic within chain.output:', error);
                    outputLog += ' (Error in sync check)';
                }
            } else {
                // Not in sync mode and not a checkInterval block
                // Provide a lighter log for non-check intervals in normal mode
                const localLag = steem.getBehindBlocks(); // Use the last known lag from steem.ts
                const netMedian = steem.getNetworkOverallBehindBlocks().medianBehind; // Get current network median
                outputLog += ` (NORMAL - KnownLag: ${localLag}, NetMedLag: ${netMedian})`;
            }
        }
        if (block._id % REPLAY_OUTPUT === 0 || (!rebuilding && !p2p.recovering)) logger.info(outputLog);
        else logger.trace(outputLog);

        chain.nextOutput = { txs: 0, dist: '0' };
    },

    applyHardfork: (block: any, cb: (err: any, result: any) => void) => {
        // TODO: Implement hardfork logic as needed
        cb(null, { executed: false, distributed: 0 });
    },

    applyHardforkPostBlock: (_blockNum: number) => {
        // TODO: Implement post-block hardfork logic as needed
    },

    batchLoadBlocks: (blockNum: number, cb: (block: any) => void) => {
        if (chain.blocksToRebuild.length === 0)
            if (blocks.isOpen) {
                chain.blocksToRebuild = blocks.readRange(blockNum, blockNum + 9999);
                cb(chain.blocksToRebuild.shift());
            } else {
                cb(undefined);
            }
        else cb(chain.blocksToRebuild.shift());
    },

    rebuildState: function (blockNum: number, cb: (err: any, headBlockNum: number) => void): void {
        logger.info(`Rebuilding chain state from block ${blockNum}`);
        if (chain.shuttingDown) {
            return cb(null, blockNum);
        }
        if (blockNum === 0) {
            chain.recentBlocks = [this.getGenesisBlock()];
            chain.schedule = witnessesModule.witnessSchedule(this.getGenesisBlock());
            this.rebuildState(blockNum + 1, cb);
            return;
        }
        this.batchLoadBlocks(blockNum, async (blockToRebuild: Block | null) => {
            if (!blockToRebuild) {
                return cb(null, blockNum);
            }
            try {
                this.executeBlockTransactions(blockToRebuild, true, (validTxs: Transaction[], dist: string) => {
                    if (blockToRebuild.txs.length !== validTxs.length) {
                        logger.error('Invalid transaction found in block during rebuild');
                        return cb('Invalid transaction in block', blockNum);
                    }
                    if (blockToRebuild.dist !== dist) {
                        logger.error(`Wrong distribution amount: ${blockToRebuild.dist} vs ${dist}`);
                        return cb('Wrong distribution amount', blockNum);
                    }
                    this.addRecentTxsInBlock(blockToRebuild.txs);
                    config.read(blockToRebuild._id);

                    chain.applyHardforkPostBlock(blockToRebuild._id);
                    // Continue with next block
                    chain.cleanMemory();
                    witnessesStats.processBlock(blockToRebuild);
                    txHistory.processBlock(blockToRebuild);

                    let writeInterval = parseInt(process.env.REBUILD_WRITE_INTERVAL!);
                    if (isNaN(writeInterval) || writeInterval < 1) writeInterval = 10000;

                    cache.processRebuildOps(
                        () => {
                            if (blockToRebuild._id % config.witnesses === 0) chain.schedule = witnessesModule.witnessSchedule(blockToRebuild);
                            chain.recentBlocks.push(blockToRebuild);
                            chain.output(blockToRebuild, true);

                            // process notifications and witness stats (non blocking)
                            notifications.processBlock(blockToRebuild);

                            // next block
                            chain.rebuildState(blockNum + 1, cb);
                        },
                        blockToRebuild._id % writeInterval === 0
                    );
                });
            } catch (error) {
                logger.error('Error rebuilding state:', error);
                return cb(error, blockNum);
            }
        });
    },

    addBlock: async (block: any, cb: (err?: any) => void) => {
        if (blocks && typeof blocks.isOpen !== 'undefined' && blocks.isOpen) {
            try {
                await blocks.appendBlock(block);
            } catch (levelDbError) {
                if (logger) logger.error(`Error appending block to LevelDB: _id=${block._id}`, levelDbError);
                try {
                    await mongo.getDb().collection('blocks').insertOne(block);
                } catch (mongoError) {
                    if (logger) logger.error(`Error inserting block into MongoDB after LevelDB fail: _id=${block._id}`, mongoError);
                    return cb(mongoError);
                }
            }
        } else {
            try {
                const db = mongo.getDb();
                await db.collection('blocks').updateOne({ _id: block._id }, { $set: block }, { upsert: true });
            } catch (error) {
                if (logger) logger.error(`Error inserting block into MongoDB: _id=${block._id}`, error);
                return cb(error);
            }
        }
        chain.cleanMemory();
        const configBlock = config.read(block._id);
        witnessesStats.processBlock(block);
        txHistory.processBlock(block);
        // if block id is mult of n witnesss, reschedule next n blocks
        if (block._id % configBlock.witnesses === 0) chain.schedule = witnessesModule.witnessSchedule(block);
        chain.recentBlocks.push(block);
        (chain as any).lastMiningAttemptBlockId = null;
        if ((chain as any).activeMiningAttempts) {
            (chain as any).activeMiningAttempts.delete(block._id); // New system cleanup
            logger.debug(`chain.addBlock: Cleaned up mining attempt for block ${block._id}`);
        }
        if (chain.worker) {
            clearTimeout(chain.worker);
            chain.worker = null;
            logger.debug(`chain.addBlock: Cancelled pending mining timeout for block ${block._id}`);
        }

        mining.minerWorker(block);
        chain.output(block);
        // Broadcast sync status based on block interval
        // This is non-blocking and doesn't affect block processing
        const isSyncing = steem.isInSyncMode();
        const broadcastInterval = isSyncing ? SYNC_MODE_BROADCAST_INTERVAL_BLOCKS : NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS;
        if (block._id % broadcastInterval === 0) {
            setTimeout(() => {
                if (p2p && p2p.nodeId && p2p.sockets && p2p.sockets.length > 0 && !p2p.recovering) {
                    const currentStatus = {
                        nodeId: p2p.nodeId.pub,
                        behindBlocks: steem.getBehindBlocks(),
                        steemBlock: block.steemBlockNum,
                        isSyncing: isSyncing,
                        blockId: block._id,
                        consensusBlocks: undefined,
                        exitTarget: steem.getSyncExitTarget(),
                        timestamp: Date.now(),
                    };
                    logger.debug(`Broadcasting sync status on block ${block._id} (every ${broadcastInterval} blocks)`);
                    p2p.broadcastSyncStatus(currentStatus);
                }
            }, 0);
        }
        cache.writeToDisk(false, () => {
            cb(null);
        });
    },
    validateAndAddBlock: async (block: any, revalidate: boolean, cb: (err: any, newBlock: any) => void) => {
        if (chain.shuttingDown) return;
        const recoveryMode = p2p.recovering ? ' [RECOVERY]' : '';
        logger.trace(`validateAndAddBlock${recoveryMode}: Processing Block ID: ${block?._id}, Witness: ${block?.witness}, Timestamp: ${block?.timestamp}`);
        const isValid = await isValidNewBlock(block, revalidate, false);
        logger.trace(`validateAndAddBlock${recoveryMode}: isValidNewBlock for Block ID: ${block?._id} returned: ${isValid}`);
        if (!isValid) {
            logger.warn(`validateAndAddBlock${recoveryMode}: Block ID: ${block?._id} failed isValidNewBlock. Witness: ${block?.witness}`);
            return cb('Block failed basic validation', null);
        }
        logger.trace(`validateAndAddBlock: Block ID: ${block?._id} passed isValidNewBlock. Witness: ${block?.witness}`);
        chain.executeBlockTransactions(block, false, function (successfullyExecutedTxs: any[], distributed: string) {
            logger.trace(
                `validateAndAddBlock: executeBlockTransactions for Block ID: ${block?._id} completed. Valid Txs: ${successfullyExecutedTxs?.length}/${block?.txs?.length}, Distributed: ${distributed}`
            );
            // if any transaction failed execution, reject the block
            if (block.txs.length !== successfullyExecutedTxs.length) {
                logger.error(
                    `validateAndAddBlock: Not all transactions in Block ID: ${block?._id} executed successfully. Expected: ${block.txs.length}, Executed: ${successfullyExecutedTxs.length}. Rejecting block.`
                );
                // Roll back any in-memory cache mutations captured during tx executions
                try {
                    cache.rollback();
                } catch (e) {
                    logger.error('validateAndAddBlock: Error during cache rollback after tx failure:', e);
                }
                cb('Not all transactions executed successfully', null); // Signal block error
                return;
            }
            const blockDist = block.dist || '0';
            if (blockDist !== distributed) {
                logger.error(
                    `validateAndAddBlock: Wrong dist amount for Block ID: ${block?._id}. Expected: ${blockDist}, Got: ${distributed}. Rejecting block.`
                );
                try {
                    cache.rollback();
                } catch (e) {
                    logger.error('validateAndAddBlock: Error during cache rollback after dist mismatch:', e);
                }
                cb('Wrong distribution amount', null);
                return;
            }
            chain.addRecentTxsInBlock(successfullyExecutedTxs);
            transaction.removeFromPool(successfullyExecutedTxs);
            chain.addBlock(block, function () {
                if (!p2p.recovering) p2p.broadcastBlock(block);
                if (settings.useNotification) notifications.processBlock(block);
                if (!p2p.recovering) for (let i = 0; i < block.txs.length; i++) transaction.eventConfirmation.emit(block.txs[i].hash);
                cb(null, block);
            });
        });
    },

    executeBlockTransactions: async (block: any, revalidate: boolean, cb: (validTxs: any[], dist: string) => void) => {
        const executions: any[] = [];
        for (let i = 0; i < block.txs.length; i++) {
            executions.push(async function (seriesCallback: any) {
                const tx = block.txs[i];
                try {
                    await upsertAccountsReferencedInTx(tx);
                    transaction.isValid(tx, block.timestamp, (isValid: boolean, validationReason?: string) => {
                        if (!isValid) {
                            logger.error(`Transaction ${tx.hash} failed validation: ${validationReason}`);
                            return seriesCallback(new Error(`Transaction validation failed for ${tx.hash}: ${validationReason}`), null);
                        }
                        if (revalidate) {
                            seriesCallback(null, { executed: true, distributed: 0 });
                        } else {
                            transaction.execute(tx, block.timestamp, (executed, distributed) => {
                                if (!executed) {
                                    logger.error(`Transaction ${tx.hash} failed execution.`);
                                    return seriesCallback(new Error(`Transaction ${tx.hash} failed execution.`), null);
                                }
                                seriesCallback(null, { executed: true, distributed: distributed || 0 });
                            });
                        }
                    });
                } catch (e: any) {
                    const txHashInfo = tx && tx.hash ? tx.hash : 'N/A_UPSERT_FAILURE';
                    logger.error(`Failed to upsert accounts for tx ${txHashInfo} during block processing: ${e.message}`, e);
                    return seriesCallback(new Error(`Account upsertion failed for tx ${txHashInfo}: ${e.message}`), null);
                }
            });
        }
        executions.push((callback: (err: any, result: any) => void) => chain.applyHardfork(block, callback));
        series(executions, async function (err: any, results: any) {
            if (err) {
                logger.error('Error in series execution:', err);
            }
            const executedSuccesfully: any[] = [];
            let distributedInBlock = toBigInt(0);
            for (let i = 0; i < block.txs.length; i++) {
                const result = results[i];
                if (result && result.executed) {
                    executedSuccesfully.push(block.txs[i]);
                    if (result.distributed) distributedInBlock += result.distributed;
                }
            }
            const dist = await witnessesModule.witnessRewards(block.witness, block);
            distributedInBlock = toBigInt(distributedInBlock) + toBigInt(dist);
            cb(executedSuccesfully, distributedInBlock.toString());
        });
    },
};

export default chain;
