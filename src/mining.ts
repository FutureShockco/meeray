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
        let nextIndex = previousBlock._id + 1;
        let nextTimestamp = new Date().getTime();
        let nextSteemBlockNum = previousBlock.steemBlockNum + 1;
        let nextSteemBlockTimestamp = previousBlock.steemBlockTimestamp + config.blockTime;

        logger.debug(`[MINING:prepareBlock] Attempting to process Steem block ${nextSteemBlockNum}.`);
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

        // Log which block time we're using for clarity
        if (steem.isInSyncMode()) {
            logger.debug(`Using sync block time: ${blockTime}ms`)
        } else if (steem.lastSyncExitTime && new Date().getTime() - steem.lastSyncExitTime < 5000) {
            logger.warn(`Recently exited sync mode, using normal block time: ${blockTime}ms`)
        }

        // if we are the next scheduled witness, try to mine in time
        if (chain.schedule.shuffle[(block._id) % config.witnesses].name === process.env.STEEM_ACCOUNT)
            mineInMs = blockTime
        // else if the scheduled witnesses miss blocks
        // backups witnesses are available after each block time intervals
        else for (let i = 1; i < 2 * config.witnesses; i++)
            if (chain.recentBlocks[chain.recentBlocks.length - i]
                && chain.recentBlocks[chain.recentBlocks.length - i].witness === process.env.STEEM_ACCOUNT) {
                mineInMs = (i + 1) * blockTime
                break
            }

        if (mineInMs) {
            // Calculate time since last block, accounting for possible clock drift
            const currentTime = new Date().getTime()
            const timeSinceLastBlock = currentTime - block.timestamp

            // Adjust mining time - add a small buffer to ensure we mine on time
            mineInMs -= timeSinceLastBlock

            // Add a small buffer to avoid clock differences causing delays
            mineInMs += 30

            logger.debug(`[MINING:minerWorker] Calculated mineInMs: ${mineInMs}. Will try to mine for block _id ${block._id + 1}. (sync: ${steem.isInSyncMode()}), timeSinceLastBlock: ${timeSinceLastBlock}ms`);
            consensus.observer = false

            // More lenient performance check during sync mode
            if (steem.isInSyncMode()) {
                // During sync, only skip if extremely slow (less than 20% of block time)
                if (mineInMs < blockTime / 20) {
                    logger.warn('Extremely slow performance during sync, skipping block')
                    return
                }
            } else if (mineInMs < blockTime / 2) {
                logger.warn('Slow performance detected, will not try to mine next block')
                return
            }

            // Make sure the node is marked as ready to receive transactions now that we're mining
            if (steem && steem.setReadyToReceiveTransactions)
                steem.setReadyToReceiveTransactions(true)

            logger.debug(`[MINING:minerWorker] Scheduling mineBlock call in ${mineInMs}ms.`);
            chain.worker = setTimeout(function () {
                logger.debug('[MINING:minerWorker] setTimeout triggered, calling mineBlock.');
                mining.mineBlock(function (error, finalBlock) {
                    if (error)
                        logger.warn(`[MINING:minerWorker] mineBlock callback - Error mining block. finalBlock._id: ${finalBlock?._id}`, finalBlock ? '' : '(No block object)');
                    else
                        logger.info(`[MINING:minerWorker] mineBlock callback - Successfully processed/proposed block. finalBlock._id: ${finalBlock?._id}`);
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