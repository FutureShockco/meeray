import { Block, isValidNewBlock } from './block.js';
import config from './config.js';
import { blocks } from './blockStore.js';
import logger from './logger.js';
import baseX from 'base-x';
// @ts-ignore
import series from 'run-series';
import transaction from './transaction.js';
import { Transaction } from './transactions/index.js';
import mining from './mining.js';
import cache from './cache.js';
import txHistory from './txHistory.js';
import witnessesStats from './witnessesStats.js';
import { witnessesModule } from './witnesses.js';
import p2p from './p2p.js';
import notifications from './modules/notifications.js';
import mongo from './mongo.js';
import steem from './steem.js';
import { upsertAccountsReferencedInTx } from './account.js';
import _ from 'lodash';

// Add constants for block-based broadcasting
const SYNC_MODE_BROADCAST_INTERVAL_BLOCKS = 3; // Broadcast every 3 blocks in sync mode
const NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS = 6; // Broadcast every 6 blocks in normal mode
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
    lastWriteWasSlow: false, // New property to track slow cache writes
    lastBlockTime: 0, // Timestamp of when the last mining cycle started or block was processed
    alternativeBlocks: [] as any[], // Store alternative blocks for sync reconciliation

    getGenesisBlock: () => {
        const genesisBlock: Block = {
            _id: 0, // _id: 0
            blockNum: 0, // blockNum: 0
            steemBlockNum: config.steemStartBlock, // steemBlockNum: config.steemStartBlock
            steemBlockTimestamp: 0, // steemBlockTimestamp: 0
            phash: '0', // phash: '0'
            timestamp: 0, // timestamp: 0
            txs: [], // txs: []
            witness: config.masterName, // witness: config.masterName
            missedBy: '', // missedBy: ''
            dist: '0', // dist: config.witnessReward > 0 ? config.witnessReward : 0
            sync: false, // sync: false
            signature: '0000000000000000000000000000000000000000000000000000000000000000',
            hash: config.originHash
        };
        // Calculate and set the actual hash for the genesis block
        //genesisBlock.hash = calculateHashForBlock(genesisBlock);
        return genesisBlock;
    },

    getLatestBlock: () => {
        return chain.recentBlocks[chain.recentBlocks.length - 1] || chain.getGenesisBlock();
    },

    getFirstMemoryBlock: () => {
        return chain.recentBlocks[0];
    },

    addRecentTxsInBlock: (txs: any[] = []) => {
        for (let t in txs)
            chain.recentTxs[txs[t].hash] = txs[t];
    },

    cleanMemory: () => {
        chain.cleanMemoryBlocks();
        chain.cleanMemoryTx();
    },

    cleanMemoryBlocks: () => {
        let extraBlocks = chain.recentBlocks.length - (config.ecoBlocks || 10000);
        while (extraBlocks > 0) {
            chain.recentBlocks.shift();
            extraBlocks--;
        }
    },

    cleanMemoryTx: () => {
        for (const hash in chain.recentTxs)
            if (chain.recentTxs[hash].ts + (config.txExpirationTime || 3600000) < chain.getLatestBlock().timestamp)
                delete chain.recentTxs[hash];
    },

    output: async (block: any, rebuilding?: boolean) => {
        chain.nextOutput.txs += block.txs.length;
        if (block.dist)
            chain.nextOutput.dist = (BigInt(chain.nextOutput.dist) + BigInt(block.dist)).toString();

        let currentOutTime = new Date().getTime();
        let outputLog = '';
        if (rebuilding)
            outputLog += 'Rebuilt ';
        outputLog += '#' + block._id;
        if (rebuilding)
            outputLog += '/' + chain.restoredBlocks;
        else
            outputLog += '  by ' + block.witness;
        outputLog += '  ' + chain.nextOutput.txs + ' tx';
        if (chain.nextOutput.txs > 1)
            outputLog += 's';
        const distInECH = (Number(chain.nextOutput.dist) / Math.pow(10, config.nativeTokenPrecision));
        outputLog += '  dist: ' + distInECH + ' ' + config.nativeToken;
        outputLog += '  delay: ' + (currentOutTime - block.timestamp);
        if (block.missedBy && !rebuilding)
            outputLog += '  MISS: ' + block.missedBy;

        // Add sync status information
        if (!rebuilding && !p2p.recovering) {
            const checkInterval = steem.isInSyncMode() ? SYNC_MODE_BROADCAST_INTERVAL_BLOCKS : NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS;
            // Always try to update and log sync status if in sync mode, or at the defined interval for normal mode.
            if (steem.isInSyncMode() || block._id % checkInterval === 0) {
                try {
                    const currentSteemHead = await steem.getLatestSteemBlockNum();
                    const ourLastProcessedSteemBlock = block.steemBlockNum;

                    if (currentSteemHead && ourLastProcessedSteemBlock) {
                        const localSteemDelayCorrected = Math.max(0, currentSteemHead - ourLastProcessedSteemBlock);
                        steem.updateLocalSteemState(localSteemDelayCorrected, currentSteemHead); // Inform steem.ts of local lag

                        const networkOverall = steem.getNetworkOverallBehindBlocks();

                        let syncDecisionLog = `Steem Head: ${currentSteemHead}, Sidechain Steem Block: ${ourLastProcessedSteemBlock}. Local Lag: ${localSteemDelayCorrected}. `;
                        syncDecisionLog += `Net (rpt: ${networkOverall.numReporting}): MaxLag: ${networkOverall.maxBehind}, MedLag: ${networkOverall.medianBehind}. `;
                        syncDecisionLog += `Witnesses (rpt: ${networkOverall.numWitnessesReporting}, behind: ${networkOverall.witnessesBehindThreshold}).`;
                        // logger.info(syncDecisionLog); // This can be very verbose, let's integrate parts into main outputLog

                        if (steem.isInSyncMode()) {
                            outputLog += ' (SYNCING - ';
                            if (localSteemDelayCorrected > 0) {
                                outputLog += `${localSteemDelayCorrected} blocks behind Steem`;

                                const processingRate = 1;  // blocks per second in sync mode
                                const steemProductionRate = 1 / 3;  // Steem blocks per second
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
                                logger.info(`CONDITIONS MET TO EXIT SYNC MODE. Local delay: ${localSteemDelayCorrected}. Network consensus for exit is YES. Attempting exit.`);
                                steem.exitSyncMode(block._id, currentSteemHead); // Pass current Steem head
                                outputLog += ' (Exiting Sync Mode)';
                            } else {
                                // logger.info(`Still in SYNC MODE. Local delay: ${localSteemDelayCorrected}. Network consensus for exit is NO.`);
                            }
                        } else { // Not in sync mode
                            // Evaluate entry conditions
                            const criticalLocalDelayThreshold = (config as any).steemBlockDelayCritical || 10;
                            const networkMedianEntryThreshold = (config as any).steemBlockDelayNetworkEntry || Math.max(10, ((config as any).steemBlockDelay || 10) * 1.5);
                            const witnessLagThreshold = (config as any).steemBlockDelayWitnessLagThreshold || ((config as any).steemBlockDelay || 10);

                            const activeWitnessAccounts = chain.schedule?.active_witnesses || (config as any).activeWitnesses || [];
                            const minWitnessesLaggingForEntryFactor = activeWitnessAccounts.length > 0 ? Math.max(1, Math.ceil(activeWitnessAccounts.length * ((config as any).syncEntryWitnessQuorumMinPercentForFactor || 0.3))) : 0;

                            const isLocallyCritical = localSteemDelayCorrected > criticalLocalDelayThreshold;
                            const isNetworkMedianLagHigh = networkOverall.medianBehind > networkMedianEntryThreshold;
                            const areEnoughWitnessesLagging = activeWitnessAccounts.length > 0 && networkOverall.witnessesBehindThreshold >= minWitnessesLaggingForEntryFactor;

                            let entryReason = "";
                            if (isLocallyCritical) entryReason += "Local node critically lagging. ";
                            if (isNetworkMedianLagHigh) entryReason += "Network median Steem lag high. ";
                            if (areEnoughWitnessesLagging) entryReason += "Sufficient active witnesses lagging. ";

                            if (isLocallyCritical || isNetworkMedianLagHigh || areEnoughWitnessesLagging) {
                                logger.info(`Primary condition(s) for sync mode met: ${entryReason}Local Lag: ${localSteemDelayCorrected}, Network Median: ${networkOverall.medianBehind}, Reporting Witnesses Lagging: ${networkOverall.witnessesBehindThreshold}/${minWitnessesLaggingForEntryFactor} (threshold: >${witnessLagThreshold}).`);
                                if (steem.isNetworkReadyToEnterSyncMode(localSteemDelayCorrected, steem.isInSyncMode())) {
                                    logger.info("Network IS ready for coordinated sync mode entry. Attempting entry.");
                                    steem.enterSyncMode();
                                    outputLog += ` (Entering Sync - Lag: ${localSteemDelayCorrected}, NetMedLag: ${networkOverall.medianBehind})`;
                                } else {
                                    logger.info("Network is NOT YET ready for coordinated sync mode entry (quorum pending).");
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
            } else { // Not in sync mode and not a checkInterval block
                // Provide a lighter log for non-check intervals in normal mode
                const localLag = steem.getBehindBlocks(); // Use the last known lag from steem.ts
                const netMedian = steem.getNetworkOverallBehindBlocks().medianBehind; // Get current network median
                outputLog += ` (NORMAL - KnownLag: ${localLag}, NetMedLag: ${netMedian})`;
            }
        }
        if (block._id % REPLAY_OUTPUT === 0 || (!rebuilding && !p2p.recovering))
            logger.info(outputLog);
        else
            logger.debug(outputLog);

        chain.nextOutput = { txs: 0, dist: '0' };
    },

    applyHardfork: (block: any, cb: (err: any, result: any) => void) => {
        // TODO: Implement hardfork logic as needed
        cb(null, { executed: false, distributed: 0 });
    },

    applyHardforkPostBlock: (blockNum: number) => {
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

        // If chain shutting down, stop rebuilding and output last number for resuming
        if (chain.shuttingDown) {
            return cb(null, blockNum);
        }

        // Genesis block is handled differently
        if (blockNum === 0) {
            chain.recentBlocks = [this.getGenesisBlock()];
            chain.schedule = witnessesModule.witnessSchedule(this.getGenesisBlock());
            this.rebuildState(blockNum + 1, cb);
            return;
        }

        // Process blocks in batches
        this.batchLoadBlocks(blockNum, async (blockToRebuild: Block | null) => {
            if (!blockToRebuild) {
                // Rebuild is complete
                return cb(null, blockNum);
            }

            try {
                // Execute transactions in the block
                this.executeBlockTransactions(blockToRebuild, true, (validTxs: Transaction[], dist: string) => {
                    if (blockToRebuild.txs.length !== validTxs.length) {
                        logger.error('Invalid transaction found in block during rebuild');
                        return cb('Invalid transaction in block', blockNum);
                    }

                    // Verify distribution amount
                    if (blockToRebuild.dist !== dist) {
                        logger.error(`Wrong distribution amount: ${blockToRebuild.dist} vs ${dist}`);
                        return cb('Wrong distribution amount', blockNum);
                    }

                    // Add transactions to recent transactions
                    this.addRecentTxsInBlock(blockToRebuild.txs);
                    const configBlock = config.read(blockToRebuild._id)

                    chain.applyHardforkPostBlock(blockToRebuild._id)
                    // Continue with next block
                    chain.cleanMemory()
                    witnessesStats.processBlock(blockToRebuild)
                    txHistory.processBlock(blockToRebuild)

                    let writeInterval = parseInt(process.env.REBUILD_WRITE_INTERVAL!)
                    if (isNaN(writeInterval) || writeInterval < 1)
                        writeInterval = 10000

                    cache.processRebuildOps(() => {
                        if (blockToRebuild._id % config.witnesses === 0)
                            chain.schedule = witnessesModule.witnessSchedule(blockToRebuild)
                        chain.recentBlocks.push(blockToRebuild)
                        chain.output(blockToRebuild, true)

                        // process notifications and witness stats (non blocking)
                        notifications.processBlock(blockToRebuild)

                        // next block
                        chain.rebuildState(blockNum + 1, cb)
                    }, blockToRebuild._id % writeInterval === 0)
                });
            } catch (error) {
                logger.error('Error rebuilding state:', error);
                return cb(error, blockNum);
            }
        });
    },

    // Block addition and validation
    addBlock: async (block: any, cb: (err?: any) => void) => {
        // add the block in our own db
        if (blocks && typeof blocks.isOpen !== 'undefined' && blocks.isOpen) {
            try {
                // Assuming blocks.appendBlock might be synchronous or promise-based
                // If it's callback-based, this would need adjustment.
                await blocks.appendBlock(block);
            } catch (levelDbError) {
                if (logger) logger.error(`Error appending block to LevelDB: _id=${block._id}`, levelDbError);
                // Decide if we should fallback to MongoDB or return error
                // For now, let's try to fallback if LevelDB fails, or just error out if LevelDB was the primary expected store
                // Fallback to MongoDB if appendBlock fails:
                try {
                    await mongo.getDb().collection('blocks').insertOne(block)
                } catch (mongoError) {
                    if (logger) logger.error(`Error inserting block into MongoDB after LevelDB fail: _id=${block._id}`, mongoError);
                    return cb(mongoError); // Return error to original callback
                }
            }
        } else {
            try {
                // Former Mongoose call: await BlockModel.updateOne({ _id: block._id }, { $set: block }, { upsert: true }).exec();
                const db = mongo.getDb();
                await db.collection('blocks').updateOne({ _id: block._id }, { $set: block }, { upsert: true });
            } catch (error) { // This catches errors from the MongoDB operation
                if (logger) logger.error(`Error inserting block into MongoDB: _id=${block._id}`, error);
                return cb(error); // Return error to original callback
            }
        }
        // push cached accounts and contents to mongodb
        chain.cleanMemory();
        // update the config if an update was scheduled
        const configBlock = config.read(block._id);

        witnessesStats.processBlock(block);
        txHistory.processBlock(block);

        // if block id is mult of n witnesss, reschedule next n blocks
        if (block._id % configBlock.witnesses === 0)
            chain.schedule = witnessesModule.witnessSchedule(block);

        chain.recentBlocks.push(block);
        mining.minerWorker(block);
        chain.output(block);

        // Broadcast sync status based on block interval
        // This is non-blocking and doesn't affect block processing
        const isSyncing = steem.isInSyncMode();
        const broadcastInterval = isSyncing ?
            SYNC_MODE_BROADCAST_INTERVAL_BLOCKS :
            NORMAL_MODE_BROADCAST_INTERVAL_BLOCKS;

        // Broadcast every N blocks based on sync mode
        if (block._id % broadcastInterval === 0) {
            // Use setTimeout to make this non-blocking
            setTimeout(() => {
                // Only broadcast if p2p is available and we have peers
                if (p2p && p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
                    const currentStatus = {
                        nodeId: p2p.nodeId.pub,
                        behindBlocks: steem.getBehindBlocks(),
                        steemBlock: block.steemBlockNum,
                        isSyncing: isSyncing,
                        blockId: block._id,
                        consensusBlocks: undefined,
                        exitTarget: steem.getSyncExitTarget(),
                        timestamp: Date.now()
                    };

                    logger.debug(`Broadcasting sync status on block ${block._id} (every ${broadcastInterval} blocks)`);
                    p2p.broadcastSyncStatus(currentStatus);
                }
            }, 0);
        }

        cache.writeToDisk(false, () => { // writeToDisk has its own callback
            cb(null); // Call original cb after writeToDisk's callback completes
        });
    },
    validateAndAddBlock: async (block: any, revalidate: boolean, cb: (err: any, newBlock: any) => void) => {
        if (chain.shuttingDown) return
        logger.debug(`[validateAndAddBlock] Entered. Block ID: ${block?._id}, Revalidate: ${revalidate}, Witness: ${block?.witness}`);

        // Log the received block before validation begins
        isValidNewBlock(block, revalidate, false, function (isValid: boolean) {
            logger.debug(`[validateAndAddBlock] isValidNewBlock for Block ID: ${block?._id} returned: ${isValid}`);
            if (!isValid) {
                logger.warn(`[validateAndAddBlock] Block ID: ${block?._id} failed isValidNewBlock. Witness: ${block?.witness}`);
                return cb("Block failed basic validation", null);
            }
            logger.debug(`Block ID: ${block?._id} passed isValidNewBlock. Witness: ${block?.witness}`); // Changed from console.log
            // straight execution
            chain.executeBlockTransactions(block, false, function (successfullyExecutedTxs: any[], distributed: string) {
                logger.debug(`[validateAndAddBlock] executeBlockTransactions for Block ID: ${block?._id} completed. Valid Txs: ${successfullyExecutedTxs?.length}/${block?.txs?.length}, Distributed: ${distributed}`);

                // if any transaction failed execution, reject the block
                if (block.txs.length !== successfullyExecutedTxs.length) {
                    logger.error(`[validateAndAddBlock] Not all transactions in Block ID: ${block?._id} executed successfully. Expected: ${block.txs.length}, Executed: ${successfullyExecutedTxs.length}. Rejecting block.`);
                    cb("Not all transactions executed successfully", null); // Signal block error
                    return;
                }

                // All transactions executed successfully if we reach here.

                // error if distributed computed amounts are different than the reported one
                let blockDist = block.dist || "0";
                if (blockDist !== distributed) {
                    logger.error(`[validateAndAddBlock] Wrong dist amount for Block ID: ${block?._id}. Expected: ${blockDist}, Got: ${distributed}. Rejecting block.`);
                    cb("Wrong distribution amount", null); // Signal block error
                    return;
                }

                // Now that the block is fully validated and all txs are good:
                chain.addRecentTxsInBlock(successfullyExecutedTxs); // Use successfullyExecutedTxs
                transaction.removeFromPool(successfullyExecutedTxs); // Use successfullyExecutedTxs

                chain.addBlock(block, function () {
                    // and broadcast to peers (if not replaying)
                    if (!p2p.recovering)
                        p2p.broadcastBlock(block)

                    // process notifications and witness stats (non blocking)
                    if (process.env.USE_NOTIFICATION === 'true')
                        notifications.processBlock(block)

                    // emit event to confirm new transactions in the http api
                    if (!p2p.recovering)
                        for (let i = 0; i < block.txs.length; i++)
                            transaction.eventConfirmation.emit(block.txs[i].hash)

                    cb(null, block)
                })
            })
        });
    },

    executeBlockTransactions: async (block: any, revalidate: boolean, cb: (validTxs: any[], dist: string) => void) => {
        // revalidating transactions in orders if revalidate = true
        // adding transaction to recent transactions (to prevent tx re-use) if isFinal = true
        let executions: any[] = [];
        for (let i = 0; i < block.txs.length; i++) {
            // The function for run-series
            executions.push(async function (seriesCallback: any) {
                let tx = block.txs[i];

                try {
                    // STEP 1: Ensure accounts exist
                    await upsertAccountsReferencedInTx(tx);

                    // STEP 2: Proceed with validation using the global transaction.isValid method
                    transaction.isValid(tx, block.timestamp, (isValid: boolean, validationReason?: string) => {
                        if (!isValid) {
                            logger.error(`Transaction ${tx.hash} failed validation: ${validationReason}`);
                            return seriesCallback(new Error(`Transaction validation failed for ${tx.hash}: ${validationReason}`), null);
                        }

                        // If validation passes:
                        if (revalidate) {
                            // During revalidation, if tx is valid, mark as 'executed' (meaning validated) for series result.
                            seriesCallback(null, { executed: true, distributed: 0 });
                        } else {
                            // Not revalidating (normal block processing), so execute the transaction
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

        series(executions, function (err: any, results: any) {
            let string = 'executed'
            if (revalidate) string = 'validated & ' + string
            if (err) {
                logger.error('Error in series execution:', err);
            }
            // First result is from account creation
            let executedSuccesfully: any[] = [];
            let distributedInBlock = BigInt(0);
            for (let i = 0; i < block.txs.length; i++) {
                const result = results[i];
                if (result && result.executed) {
                    executedSuccesfully.push(block.txs[i]);
                    if (result.distributed) distributedInBlock += result.distributed;
                }
            }
            // add rewards for the witness who mined this block
            witnessesModule.witnessRewards(block.witness, block.timestamp, function (dist: string) {
                distributedInBlock = BigInt(distributedInBlock) + BigInt(dist);
                cb(executedSuccesfully, distributedInBlock.toString());
            });
        });
    },
};

export default chain; 