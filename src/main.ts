import 'dotenv/config';

// TODO: Uncomment and install these dependencies as you migrate the rest of the Echelon codebase
// import config from './config.js';
// import logger from './logger.js';
// import ... (other dependencies)

// TODO: Add proper types for main logic, state, etc.
import http from './modules/http/index.js';
import logger from './logger.js';
import config from './config.js';
import { p2p } from './p2p.js';
import { chain } from './chain.js';
import { transaction } from './transaction.js';
import { cache } from './cache.js';
import { witnessesStats } from './witnessesStats.js';
import { BlockModel } from './models/block.js';

import { blocks } from './blockStore.js';
import {mongo} from './mongo.js';
// import validate from './validate.js'; // Uncomment when available
import witnessesModule from './witnesses.js';

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal('Unhandled Rejection at:', { promise, reason });
  // Application specific logging, throwing an error, or other logic here
  // It is generally recommended to exit the process on unhandled rejections after logging.
  process.exit(1);
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
    // init the database and load most recent blocks in memory directly
    await mongo.init(async function (state: any) {
        // init blocks BSON if not using mongodb for blocks
        await blocks.init(state);

        // Warmup accounts
        let timeStart = Date.now();
        await cache.warmup?.('accounts', parseInt(process.env.WARMUP_ACCOUNTS || '10000'));
        logger.info(Object.keys((cache as any).accounts || {}).length + ' accounts loaded in RAM in ' + (Date.now() - timeStart) + ' ms');

        // Warmup tokens
        timeStart = Date.now();
        await cache.warmup?.('tokens', parseInt(process.env.WARMUP_TOKENS || '1000'));
        logger.info(Object.keys((cache as any).tokens || {}).length + ' tokens loaded in RAM in ' + (Date.now() - timeStart) + ' ms');

        // Warmup leaders
        timeStart = Date.now();
        let leaderCount = await cache.warmupLeaders?.();
        logger.info((leaderCount || 0) + ' leaders loaded in RAM in ' + (Date.now() - timeStart) + ' ms');

        // Warmup leader stats
        await witnessesStats.loadIndex?.();

        // Rebuild chain state if specified
        let rebuildResumeBlock = state && state.headBlock ? state.headBlock + 1 : 0;
        let isResumingRebuild = process.env.REBUILD_STATE === '1' && rebuildResumeBlock;

        if (process.env.REBUILD_STATE === '1') {
            if (process.env.REBUILD_NO_VALIDATE === '1')
                logger.info('Rebuilding without validation. Only use this if you know what you are doing!');
            else if (process.env.REBUILD_NO_VERIFY === '1')
                logger.info('Rebuilding without signature verification. Only use this if you know what you are doing!');
        }

        if (process.env.REBUILD_STATE === '1' && !isResumingRebuild) {
            logger.info('Chain state rebuild requested' + (process.env.UNZIP_BLOCKS === '1' && !blocks.isOpen ? ', unzipping blocks.zip...' : ''));
            if (!blocks.isOpen) {
                await mongo.restoreBlocks((e: string | null) => {
                    if (e) return logger.error(e);
                    startRebuild(0);
                });
            } else {
                startRebuild(0);
            }
            return;
        }

        let block = blocks.isOpen ? blocks.lastBlock?.() : await mongo.lastBlock();
        // Resuming an interrupted rebuild
        if (isResumingRebuild) {
            logger.info('Resuming interrupted rebuild from block ' + rebuildResumeBlock);
            chain.restoredBlocks = block?._id;
            let blkScheduleStart = rebuildResumeBlock - 1 - ((rebuildResumeBlock - 1) % (config.witnesses || 1));
            if (!blocks.isOpen) {
                await mongo.fillInMemoryBlocks?.(() => {
                    BlockModel.findOne({ _id: blkScheduleStart }, (e: any, b: any) => {
                        chain.schedule = witnessesModule.witnessSchedule(b);
                        startRebuild(rebuildResumeBlock);
                    });
                    startRebuild(rebuildResumeBlock);
                }, rebuildResumeBlock);
            } else {
                blocks.fillInMemoryBlocks?.(rebuildResumeBlock);
                chain.schedule = witnessesModule.witnessSchedule(blocks.read?.(blkScheduleStart));
                startRebuild(rebuildResumeBlock);
            }
            return;
        }
        logger.info('#' + (block?._id ?? '?') + ' is the latest block in our db');
        // config = require('./config.js').read(block._id); // Not needed, config is static in TS
        if (blocks.isOpen) {
            blocks.fillInMemoryBlocks?.();
            startDaemon();
        } else {
            await mongo.fillInMemoryBlocks?.(startDaemon);
        }
    });
}

function startRebuild(startBlock: number) {
    let rebuildStartTime = Date.now();
    chain.lastRebuildOutput = rebuildStartTime;
    chain.rebuildState?.(startBlock, (e: any, headBlockNum?: number) => {
        if (e) {
            erroredRebuild = true;
            return logger.error('Error rebuilding chain at block', headBlockNum, e);
        } else if (headBlockNum && headBlockNum <= chain.restoredBlocks) {
            logger.info('Rebuild interrupted at block ' + headBlockNum + ', so far it took ' + (Date.now() - rebuildStartTime) + ' ms.');
        } else {
            logger.info('Rebuilt ' + headBlockNum + ' blocks successfully in ' + (Date.now() - rebuildStartTime) + ' ms');
        }
        logger.info('Writing rebuild data to disk...');
        let cacheWriteStart = Date.now();
        (cache as any).writeToDisk?.(true, () => {
            logger.info('Rebuild data written to disk in ' + (Date.now() - cacheWriteStart) + ' ms');
            if (chain.shuttingDown || process.env.TERMINATE_AFTER_REBUILD === '1') {
                if (blocks.isOpen) blocks.close?.();
                process.exit(0);
            }
            startDaemon();
        });
    });
}

async function startDaemon() {
    // start witness schedule
    let blkScheduleStart = chain.getLatestBlock()._id - (chain.getLatestBlock()._id % config.witnesses)
    if (blocks.isOpen)
        chain.schedule = witnessesModule.witnessSchedule(blocks.read(blkScheduleStart))
    else {
        const block = await BlockModel.findOne({ _id: blkScheduleStart })
        chain.schedule = witnessesModule.witnessSchedule(block)
    }

    // start the http server
    http.init()
    // start the websocket server
    p2p.init?.();
    // and connect to peers
    p2p.connect?.(process.env.PEERS ? process.env.PEERS.split(',') : [], true);
    // keep peer connection alive
    setTimeout(() => p2p.keepAlive?.(), 3000);

    // regularly clean up old txs from mempool
    setInterval(() => {
        transaction.cleanPool?.();
    }, (config.blockTime || 3000) * 0.9);
}

process.on('SIGINT', async function () {
    if (closing) return;
    closing = true;
    chain.shuttingDown = true;

    logger.info('Received SIGINT, completing writer queue...');

    const shutdownCheck = setInterval(() => {
        const isQueueEmpty = cache.writerQueue?.queue?.length === 0;
        const isProcessing = cache.writerQueue?.processing;

        logger.debug(`Waiting for writerQueue... queue=${cache.writerQueue?.queue?.length}, processing=${isProcessing}`);

        if (isQueueEmpty && !isProcessing) {
            clearInterval(shutdownCheck);
            logger.info('Echelon exited safely');
            process.exit(0);
        }
    }, 1000);

    // Force exit after timeout
    setTimeout(() => {
        logger.warn('Forcing shutdown after 30s timeout...');
        process.exit(1);
    }, 30_000);
});

// If this is the entrypoint, run main
main();


export default main; 