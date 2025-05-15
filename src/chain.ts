// TODO: Uncomment and install these dependencies as you migrate the rest of the Echelon codebase
// import ... (other dependencies)

// TODO: Add proper types for chain logic, blocks, state, etc.

import { Block, isValidNewBlock } from './block.js';
import { BlockModel } from './models/block.js';
import config from './config.js';
import { blocks } from './blockStore.js';
import logger from './logger.js';
import secp256k1 from 'secp256k1';
import { createHash, randomBytes } from 'crypto';
import baseX from 'base-x';
import cloneDeep from 'clone-deep';
import CryptoJS from 'crypto-js';
// @ts-ignore
import series from 'run-series';
import transaction from './transaction.js';
import { Transaction } from './transactions/index.js';
import mining from './mining.js';
import cache from './cache.js';
import txHistory from './transactions/txHistory.js';
import witnessesStats from './witnessesStats.js';
import witnessesModule from './witnesses.js';
import p2p from './p2p.js';
import notifications from './modules/notifications.js';
// import mining from './mining.js';
// import witnesses from './witnesses.js';
// import cache from './cache.js';
// import notifications from './notifications.js';

const bs58 = baseX(config.b58Alphabet);

export const chain = {
    blocksToRebuild: [] as any[],
    restoredBlocks: 0,
    schedule: null as any,
    recentBlocks: [] as any[],
    recentTxs: {} as Record<string, any>,
    nextOutput: { txs: 0, dist: 0, burn: 0 },
    lastRebuildOutput: 0,
    worker: null as any,
    shuttingDown: false,
    getNewKeyPair: () => {
        let privKey, pubKey;
        do {
            privKey = randomBytes(32); // config.randomBytesLength assumed 32
            pubKey = secp256k1.publicKeyCreate(privKey);
        } while (!secp256k1.privateKeyVerify(privKey));
        return {
            pub: bs58.encode(pubKey),
            priv: bs58.encode(privKey)
        };
    },
    calculateBlockHash: (
        index: number, 
        phash: string, 
        timestamp: number, 
        txs: Transaction[], 
        witness: string, 
        missedBy: string = '',
        distributed: number = 0
    ): string => {
        try {
            // Simple implementation for hash calculation
            const data = `${index}${phash}${timestamp}${JSON.stringify(txs)}${witness}${missedBy}${distributed}`;
            const hash = createHash('sha256').update(data).digest('hex');
            return hash;
        } catch (error) {
            logger.error('Error calculating block hash:', error);
            return '';
        }
    },
    getGenesisBlock: () => {
        const genesisBlock: Block = {
            _id: 0, // _id: 0
            blockNum: 0, // blockNum: 0
            steemBlockNum: config.steemStartBlock, // steemBlockNum: config.steemStartBlock
            phash: '0', // phash: '0'
            timestamp: 0, // timestamp: 0
            steemBlockTimestamp: 0, // steemBlockTimestamp: 0
            sync: false, // sync: false
            txs: [], // txs: []
            witness: config.masterName, // witness: config.masterName
            hash: '', // hash: '' (will be set below)
            signature: config.originHash, // signature: config.originHash
            missedBy: '', // missedBy: ''
            dist: config.witnessReward > 0 ? config.witnessReward : 0, // dist: config.witnessReward > 0 ? config.witnessReward : 0
        };
        // Calculate and set the actual hash for the genesis block
        genesisBlock.hash = chain.calculateBlockHash(
            genesisBlock._id,
            genesisBlock.phash,
            genesisBlock.timestamp,
            genesisBlock.txs,
            genesisBlock.witness,
            genesisBlock.missedBy,
            genesisBlock.dist
        );
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
        // TODO: config.ecoBlocksIncreasesSoon logic
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

    output: (block: any, rebuilding?: boolean) => {
        chain.nextOutput.txs += block.txs.length;
        if (block.dist)
            chain.nextOutput.dist += block.dist;
        if (block.burn)
            chain.nextOutput.burn += block.burn;
        // TODO: replay_output logic
        let currentOutTime = new Date().getTime();
        let output = '';
        if (rebuilding)
            output += 'Rebuilt ';
        output += '#' + block._id;
        if (rebuilding)
            output += '/' + chain.restoredBlocks;
        else
            output += '  by ' + block.witness;
        output += '  ' + chain.nextOutput.txs + ' tx';
        if (chain.nextOutput.txs > 1)
            output += 's';
        output += '  dist: ' + (chain.nextOutput.dist);
        output += '  burn: ' + (chain.nextOutput.burn);
        output += '  delay: ' + (currentOutTime - block.timestamp);
        if (block.missedBy && !rebuilding)
            output += '  MISS: ' + block.missedBy;
        logger.info(output);
        chain.nextOutput = { txs: 0, dist: 0, burn: 0 };
    },

    applyHardfork: (block: any, cb: (err: any, result: any) => void) => {
        // TODO: Implement hardfork logic as needed
        cb(null, { executed: false, distributed: 0, burned: 0 });
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
                // TODO: MongoDB fallback
                cb(undefined);
            }
        else cb(chain.blocksToRebuild.shift());
    },

    rebuildState: function(blockNum: number, cb: (err: any, headBlockNum: number) => void): void {
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
            this.executeBlockTransactions(blockToRebuild, true, (validTxs: Transaction[], dist: number) => {
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
                
                // process notifications and leader stats (non blocking)
                notifications.processBlock(blockToRebuild)

                // next block
                chain.rebuildState(blockNum+1, cb)
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
        if (blocks.isOpen)
            blocks.appendBlock(block);
        else {
            try {
                await BlockModel.updateOne({ _id: block._id }, { $set: block }, { upsert: true });
            } catch (error) {
                if (logger) logger.error(`Error inserting block into MongoDB: _id=${block._id}`, error);
            }
        }
        // push cached accounts and contents to mongodb
        chain.cleanMemory();
        // update the config if an update was scheduled
        const configBlock = config.read(block._id);

        witnessesStats.processBlock(block);
        txHistory.processBlock(block);

        // if block id is mult of n leaders, reschedule next n blocks
        if (block._id % configBlock.witnesses === 0)
            chain.schedule = witnessesModule.witnessSchedule(block);

        chain.recentBlocks.push(block);
        mining.minerWorker(block);
        chain.output(block);
        cache.writeToDisk(false);
        cb(true);
    },
    validateAndAddBlock: (block: any, revalidate: boolean, cb: (err: any) => void) => {
        isValidNewBlock(block, true, revalidate, function(isValid: boolean) {
            if (!isValid) {
                cb(true);
                return;
            }
            chain.addBlock(block, function() {
                p2p.broadcastBlock(block);
                cb(null);
            });
        });
    },

    executeBlockTransactions: (block: any, revalidate: boolean, cb: (validTxs: any[], dist: number, burn: number) => void) => {
        // revalidating transactions in orders if revalidate = true
        // adding transaction to recent transactions (to prevent tx re-use) if isFinal = true
        let executions: any[] = [];
        for (let i = 0; i < block.txs.length; i++) {
            executions.push(function(callback: any) {
                let tx = block.txs[i];
                if (revalidate)
                    transaction.isValid(tx, block.timestamp, function(isValid: boolean, error: any) {
                        if (isValid)
                            transaction.execute(tx, block.timestamp, function(executed: boolean, distributed: number, burned: number) {
                                if (!executed) {
                                    logger.fatal('Tx execution failure', tx);
                                    process.exit(1);
                                }
                                callback(null, {
                                    executed: executed,
                                    distributed: distributed,
                                    burned: burned
                                });
                            });
                        else {
                            logger.error(error, tx);
                            callback(null, false);
                        }
                    });
                else
                    transaction.execute(tx, block.timestamp, function(executed: boolean, distributed: number, burned: number) {
                        if (!executed)
                            logger.fatal('Tx execution failure', tx);
                        callback(null, {
                            executed: executed,
                            distributed: distributed,
                            burned: burned
                        });
                    });
            });
        }
        // TODO: Add hardfork logic if needed
        // series(executions, ...)
        // For now, just call cb with empty arrays for compatibility
        cb([], 0, 0);
    },
};

export default chain; 