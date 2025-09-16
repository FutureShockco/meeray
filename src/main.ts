import 'dotenv/config';
import http from './modules/http/index.js';
import logger from './logger.js';
import config from './config.js';
import { p2p } from './p2p/index.js';
import { chain } from './chain.js';
import transaction from './transaction.js';
import cache from './cache.js';
import { setMongoDbInstance as setCacheMongoDbInstance } from './cache.js';
import { witnessesStats } from './modules/witnessesStats.js';
import { blocks } from './blockStore.js';
import { mongo, StateDoc } from './mongo.js'; 
import { witnessesModule } from './witnesses.js';
import { initializeModules } from './initialize.js';
import { Block } from './block.js';
import settings from './settings.js';
import { startWorker as startSteemBridgeWorker } from './modules/steemBridge.js';

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
    if (typeof logger !== 'undefined' && logger.fatal) {
        logger.fatal('CRITICAL: Unhandled Rejection at:', { promise_details: String(promise), reason_details: String(reason) });
        if (reason instanceof Error && reason.stack) {
            logger.fatal('Stack Trace:', reason.stack);
        }
    } else {
        if (reason instanceof Error && reason.stack) {
            logger.error('Stack Trace:', reason.stack);
        }
    }
});

process.on('uncaughtException', (error: Error) => {
    logger.error('CRITICAL: Uncaught Exception:', error);
    if (typeof logger !== 'undefined' && logger.fatal) {
        logger.fatal('CRITICAL: Uncaught Exception:', { errorName: error.name, errorMessage: error.message, stack: error.stack });
    } else {
        logger.error('Stack Trace:', error.stack);
    }
});

const allowNodeV = [18, 20, 22];
const currentNodeV = parseInt(process.versions.node.split('.')[0]);
if (!allowNodeV.includes(currentNodeV)) {
    logger.fatal('Wrong NodeJS version. Allowed versions: v' + allowNodeV.join(', v'));
    process.exit(1);
} else {
    logger.info('Correctly using NodeJS v' + process.versions.node);
}

let erroredRebuild = false;
let closing = false;

export async function main() {
    logger.info('Starting MeeRay Node...');

    mongo.init(async (error: Error | null, state?: StateDoc | null) => {
        if (error) {
            logger.fatal('Failed to initialize MongoDB via mongo.init:', error);
            process.exit(1);
        }
        logger.info('MongoDB initialized via mongo.init.');

        try {
            const mongoInstance = mongo.getDb();
            setCacheMongoDbInstance(mongoInstance); // Set the DB instance for the cache module
        } catch (e: any) {
            logger.fatal('[MAIN] Failed to get MongoDB instance for cache setup after mongo.init:', e.message || e);
            process.exit(1);
        }

        // Initialize modules that might depend on DB being ready
        initializeModules();
        logger.info('Core modules initialized.');

        const headBlockIdFromState = state?.headBlock || 0;
        await blocks.init(headBlockIdFromState);
        logger.info(`Block store initialized with head block ID: ${headBlockIdFromState}`);

        // Initialize currentConfig (can be updated later based on specific blocks)
        let currentConfig = config.read ? config.read(headBlockIdFromState) : config;

        // Warmup accounts
        let timeStart = new Date().getTime();
        const warmupAccountsCount = parseInt(process.env.WARMUP_ACCOUNTS || '10000');
        await cache.warmup('accounts', warmupAccountsCount);
        logger.info(`${Object.keys(cache.accounts || {}).length} accounts loaded in RAM in ${new Date().getTime() - timeStart} ms`);

        // Warmup tokens
        timeStart = new Date().getTime();
        const warmupTokensCount = parseInt(process.env.WARMUP_TOKENS || '10000');
        await cache.warmup('tokens', warmupTokensCount);
        logger.info(`${Object.keys(cache.tokens || {}).length} tokens loaded in RAM in ${new Date().getTime() - timeStart} ms`);

        // Warmup witnesses
        timeStart = new Date().getTime();
        const witnessCount = await cache.warmupWitnesses();
        logger.info(`${witnessCount} witnesses loaded in RAM in ${new Date().getTime() - timeStart} ms`);

        // Warmup witness stats
        await witnessesStats.loadIndex();

        // Rebuild chain state if specified
        const rebuildResumeBlock = state && state.headBlock ? state.headBlock + 1 : 0;
        // Ensure isResumingRebuild correctly identifies actual resumption (rebuildResumeBlock > 0)
        const isResumingRebuild = process.env.REBUILD_STATE === '1' && rebuildResumeBlock > 0;


        if (process.env.REBUILD_STATE === '1') {
            if (process.env.REBUILD_NO_VALIDATE === '1') {
                logger.warn('Rebuilding without validation. Only use this if you know what you are doing!');
            } else if (process.env.REBUILD_NO_VERIFY === '1') {
                logger.warn('Rebuilding without signature verification. Only use this if you know what you are doing!');
            }
        }

        if (process.env.REBUILD_STATE === '1' && !isResumingRebuild) {
            logger.info(`Chain state rebuild requested${(process.env.UNZIP_BLOCKS === '1' && !blocks.isOpen) ? ', unzipping blocks.zip...' : ''}`);
            if (!blocks.isOpen) {
                mongo.restoreBlocks((e?: string | null) => {
                    if (e) {
                        logger.error('Error restoring blocks for rebuild:', e);
                        // Decide if to exit or try to continue with a different approach
                        process.exit(1);
                        return;
                    }
                    startRebuild(0);
                });
            } else {
                startRebuild(0);
            }
            return;
        }

        let block = blocks.isOpen ? blocks.lastBlock() : await mongo.lastBlock();
        if (!block) {
            logger.warn('No last block found from blockStore or MongoDB, attempting to use genesis block.');
            block = chain.getGenesisBlock();
            if (!block) {
                logger.fatal('CRITICAL: Cannot determine last block or genesis block. Exiting.');
                process.exit(1);
            }
        }

        currentConfig = config.read ? config.read(block._id) : config; // Update config based on latest known block

        if (isResumingRebuild) {
            logger.info('Resuming interrupted rebuild from block ' + rebuildResumeBlock)
            currentConfig = config.read ? config.read(rebuildResumeBlock - 1) : config;
            chain.restoredBlocks = block._id
            let blkScheduleStart = rebuildResumeBlock - 1 - (rebuildResumeBlock - 1) % currentConfig.witnesses
            if (!blocks.isOpen)
                mongo.fillInMemoryBlocks(async () => { // Make outer callback async
                    try {
                        const scheduleSourceBlock = await mongo.getDb().collection<Block>('blocks').findOne({ _id: rebuildResumeBlock - 1 - (rebuildResumeBlock - 1) % currentConfig.witnesses });
                        chain.schedule = witnessesModule.witnessSchedule(scheduleSourceBlock); // scheduleSourceBlock can be null
                        startRebuild(rebuildResumeBlock);
                    } catch (e: any) {
                        logger.error('Error fetching block for schedule during rebuild resume:', e.message || e);
                        // Decide how to handle this error, e.g., startRebuild with null schedule or exit
                        startRebuild(rebuildResumeBlock); // Or handle error more gracefully
                    }
                }, rebuildResumeBlock)
            else {
                blocks.fillInMemoryBlocks(rebuildResumeBlock)
                chain.schedule = witnessesModule.witnessSchedule(blocks.read(blkScheduleStart))
                startRebuild(rebuildResumeBlock)
            }
            return
        }

        logger.info(`#${block._id} is the latest block in our db`);

        if (blocks.isOpen) {
            blocks.fillInMemoryBlocks(); 
            await startDaemon(currentConfig);
        } else {
            await mongo.fillInMemoryBlocks(async () => { 
                await startDaemon(currentConfig);
            });
        }
    });
}

function startRebuild(startBlock: number) {
    let rebuildStartTime = new Date().getTime()
    chain.lastRebuildOutput = rebuildStartTime
    chain.rebuildState(startBlock, (e, headBlockNum) => {
        if (e) {
            erroredRebuild = true
            return logger.error('Error rebuilding chain at block', headBlockNum, e)
        } else if (headBlockNum <= chain.restoredBlocks)
            logger.info('Rebuild interrupted at block ' + headBlockNum + ', so far it took ' + (new Date().getTime() - rebuildStartTime) + ' ms.')
        else
            logger.info('Rebuilt ' + headBlockNum + ' blocks successfully in ' + (new Date().getTime() - rebuildStartTime) + ' ms')
        logger.info('Writing rebuild data to disk...')
        let cacheWriteStart = new Date().getTime()
        cache.writeToDisk(true, () => {
            logger.info('Rebuild data written to disk in ' + (new Date().getTime() - cacheWriteStart) + ' ms')
            if (chain.shuttingDown || process.env.TERMINATE_AFTER_REBUILD === '1') {
                if (blocks.isOpen)
                    blocks.close()
                return process.exit(0)
            }
            const latestBlockForRebuild = chain.getLatestBlock();
            const configForDaemon = latestBlockForRebuild ? (config.read ? config.read(latestBlockForRebuild._id) : config) : config;
            startDaemon(configForDaemon);
        })
    })
}

async function startDaemon(cfg: any) {
    let blkScheduleStart = chain.getLatestBlock()._id - (chain.getLatestBlock()._id % config.witnesses)
    if (blocks.isOpen)
        chain.schedule = witnessesModule.witnessSchedule(blocks.read(blkScheduleStart))
    else {
        const block = await mongo.getDb().collection<Block>('blocks').findOne({ _id: blkScheduleStart })
        chain.schedule = witnessesModule.witnessSchedule(block)
    }


    http.init();
    p2p.init();
    p2p.connect(settings.peers, true);
    setTimeout(() => p2p.keepAlive(), 6000);

    if (settings.steemBridgeEnabled) {
        logger.info('Starting Steem bridge worker...');
        startSteemBridgeWorker();
        logger.info('Steem bridge worker started successfully.');
    }

    setInterval(() => {
        transaction.cleanPool?.();
    }, (cfg.blockTime || 3000) * 0.9);
    logger.info('Node daemon started successfully.');
}

process.on('SIGINT', async function () {
    if (closing) return;
    closing = true;
    chain.shuttingDown = true;

    logger.info('Received SIGINT, completing writer queue...');

    const shutdownCheck = setInterval(() => {
        const isQueueEmpty = cache.writerQueue?.queue?.length === 0; // Adapted for potential new cache structure
        const isProcessing = cache.writerQueue?.processing; // Adapted
        if (!erroredRebuild && chain.restoredBlocks && chain.getLatestBlock()._id < chain.restoredBlocks) return
        process.stdout.write('\r')
        logger.debug(`Waiting for writerQueue... queue=${cache.writerQueue?.queue?.length}, processing=${isProcessing}`);
        blocks.close()
        if (isQueueEmpty && !isProcessing) {
            clearInterval(shutdownCheck);
            logger.info('MeeRay exited safely');
            process.exit(0);
        }
    }, 1000);

    setTimeout(() => {
        logger.warn('Forcing shutdown after 30s timeout...');
        process.exit(1);
    }, 30000);
});

main().catch(error => {
    logger.fatal('Critical error during node startup:', error);
    process.exit(1);
});

export default main; 