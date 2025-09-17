import logger from './logger.js';
import { SteemBlockResult } from './steemParser.js';
import config from './config.js';
import { Block } from './block.js';
import p2p from './p2p/index.js';
import { chain } from './chain.js';
import SteemApiClient from './steem/apiClient.js';
import SyncManager from './steem/syncManager.js';
import BlockProcessor from './steem/blockProcessor.js';
import NetworkStatusManager from './steem/networkStatus.js';
import steemConfig from './steem/config.js';

let currentSteemBlock = 0;
let nextSteemBlock = 0;
let readyToReceiveTransactions = false;
let steemBlockPollingInterval: NodeJS.Timeout | null = null;

const apiClient = new SteemApiClient();
const syncManager = new SyncManager(apiClient);
const blockProcessor = new BlockProcessor(apiClient);
const networkStatus = new NetworkStatusManager();



const initSteemSync = (blockNum: number): void => {
    if (steemBlockPollingInterval) {
        clearInterval(steemBlockPollingInterval);
        steemBlockPollingInterval = null;
    }

    apiClient.getLatestBlockNumber().then(latestBlock => {
        if (latestBlock) {
            let lastProcessedSteemBlock = 0;
            const latestChainBlock = chain.getLatestBlock();
            if (latestChainBlock?.steemBlockNum) {
                lastProcessedSteemBlock = latestChainBlock.steemBlockNum;
            } else if (config.steemStartBlock) {
                lastProcessedSteemBlock = config.steemStartBlock;
            } else {
                lastProcessedSteemBlock = blockNum;
            }

            const behindBlocks = Math.max(0, latestBlock - lastProcessedSteemBlock);
            syncManager.updateBehindBlocks(behindBlocks);
            logger.info(`Initialized Steem Sync - ${behindBlocks} behind (Steem: ${latestBlock}, Sidechain Steem Block: ${lastProcessedSteemBlock})`);

            if (behindBlocks > 0) {
                blockProcessor.prefetchBlocks(lastProcessedSteemBlock + 1, syncManager.isInSyncMode());
            }


            if (behindBlocks > config.steemBlockMaxDelay && !syncManager.isInSyncMode()) {
                logger.info(`Already ${behindBlocks} blocks behind, entering sync mode immediately`);
                syncManager.enterSyncMode();
            }
        } else {
            logger.warn('Failed to get latest Steem block for initSteemSync, will retry with polling.');
        }
    }).catch(err => {
        logger.error('Error initializing behind blocks count in initSteemSync:', err);
    });
};

/**
 * Initialize the Steem module
 */
const init = (blockNum: number): void => {
    nextSteemBlock = blockNum;
    currentSteemBlock = blockNum - 1;
    logger.info('Initializing Steem module for block', nextSteemBlock);
    syncManager.setSyncExitTarget(null);

    const networkCheckInterval = setInterval(checkNetworkSyncStatus, 5000);
    process.on('SIGINT', () => {
        clearInterval(networkCheckInterval);
        cleanup();
    });

    checkNetworkSyncStatus().then(async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const networkSyncStatus = networkStatus.getNetworkSyncStatus();

        if (!p2p.recovering && networkSyncStatus.referenceExists && networkSyncStatus.referenceNodeId !== 'self') {
            const referenceBlock = networkSyncStatus.highestBlock;
            logger.info(`Found reference node with higher block ${referenceBlock}, prioritizing network sync first`);
            let lastRequestedBlock = chain?.getLatestBlock()?._id || 0;

            const requestBlocks = async () => {
                const currentBlock = chain?.getLatestBlock()?._id || 0;
                const blocksBehindTarget = referenceBlock - currentBlock;

                if (blocksBehindTarget <= 5) {
                    logger.info('Network sync nearly complete, starting Steem sync');
                    if (waitForNetworkSync) clearInterval(waitForNetworkSync);
                    if (blockRequestInterval) clearInterval(blockRequestInterval);
                    initSteemSync(blockNum);
                    return;
                }

                if (currentBlock === lastRequestedBlock) {
                    if (p2p?.sockets?.length > 0) {
                        const batchSize = Math.min(10, blocksBehindTarget);
                        for (let i = 0; i < batchSize; i++) {
                            const blockToRequest = currentBlock + i + 1;
                            p2p.broadcast({ t: 2, d: blockToRequest });
                        }
                        lastRequestedBlock = currentBlock + batchSize;
                        logger.info(`Requested blocks ${currentBlock + 1} to ${lastRequestedBlock} from peers`);
                    }
                }
                logger.info(`Catching up with network, head block: ${currentBlock}, target: ${referenceBlock}, ${blocksBehindTarget} blocks behind`);
            };

            const waitForNetworkSync = setInterval(requestBlocks, 3000);
            const blockRequestInterval = setInterval(requestBlocks, 3000);
            requestBlocks();
        } else {
            initSteemSync(blockNum);
        }
    }).catch(err => {
        logger.error('Error checking network sync status during init:', err);
        initSteemSync(blockNum);
    });
};

const switchToNextEndpoint = (): boolean => {
    return apiClient.switchToNextEndpoint();
};

const updateBlockId = (blockNum: number): void => {
    currentSteemBlock = blockNum;
};

const cleanup = (): void => {
    if (steemBlockPollingInterval) {
        clearInterval(steemBlockPollingInterval);
        steemBlockPollingInterval = null;
    }
    syncManager.cleanup();
    networkStatus.cleanup();
};

const processBlock = async (blockNum: number): Promise<SteemBlockResult | null> => {
    if (p2p.recovering) {
        logger.debug('Skipping Steem block processing - node not ready to receive transactions yet');
        return null;
    }

        const result = await blockProcessor.processBlock(blockNum);
        logger.debug(`steem.processBlock received result for block ${blockNum}: ${result ? 'success' : 'null'}`);
        if (result !== null) {
            return result;
        }
        await new Promise(reject => setTimeout(reject, 1000));

    return null;
};

const isOnSteemBlock = async (block: Block): Promise<boolean> => {
    return blockProcessor.validateBlockAgainstSteem(block);
};

const getLatestSteemBlockNum = async (): Promise<number | null> => {
    const latestChainBlock = chain.getLatestBlock();
    let lastProcessedSteemBlock = null;
    if (latestChainBlock?.steemBlockNum) {
        lastProcessedSteemBlock = latestChainBlock.steemBlockNum;
    } else {
        lastProcessedSteemBlock = config.steemStartBlock;
    }
    const latestSteemBlock = await apiClient.getLatestBlockNumber();
    if( !latestSteemBlock) {
        logger.warn('Failed to get latest Steem block number');
        return null;
    }
    const behindBlocks = Math.max(0, latestSteemBlock - lastProcessedSteemBlock);
    syncManager.updateBehindBlocks(behindBlocks);
    return latestSteemBlock;
};

const checkNetworkSyncStatus = async (): Promise<void> => {
    try {
        const latestSteemBlock = await apiClient.getLatestBlockNumber();
        if (!latestSteemBlock) {
            logger.warn('Failed to get latest Steem block number for network status check');
            return;
        }

        const lastProcessedSteemBlockOnSidechain = chain?.getLatestBlock()?.steemBlockNum || 0;
        const behindBlocks = Math.max(0, latestSteemBlock - lastProcessedSteemBlockOnSidechain);
        syncManager.updateBehindBlocks(behindBlocks);

        const networkSyncStatus = networkStatus.getNetworkSyncStatus();
        logger.debug(`Network sync status: Highest Block: ${networkSyncStatus.highestBlock}, Ref Node: ${networkSyncStatus.referenceNodeId}, Nodes In Sync: ${networkSyncStatus.nodesInSync}/${networkSyncStatus.totalNodes}, Our Block: ${chain?.getLatestBlock()?._id || 0}, Behind Steem: ${behindBlocks} blocks`);

        if (networkSyncStatus.referenceExists &&
            networkSyncStatus.referenceNodeId !== 'self' &&
            networkSyncStatus.highestBlock > (chain?.getLatestBlock()?._id || 0) + 10) {

            logger.warn(`Significantly behind network: our block ${chain?.getLatestBlock()?._id || 0} vs network ${networkSyncStatus.highestBlock}`);

            if (!p2p.recovering && !syncManager.isInSyncMode()) {
                logger.info('Requesting recent blocks from network to catch up with sidechain peers.');
                if (p2p?.sockets?.length > 0) {
                    const currentLocalBlock = chain?.getLatestBlock()?._id || 0;
                    const blocksToCatchup = networkSyncStatus.highestBlock - currentLocalBlock;
                    const batchSize = Math.min(10, blocksToCatchup);
                    for (let i = 0; i < batchSize; i++) {
                        const blockToRequest = currentLocalBlock + i + 1;
                        p2p.broadcast({ t: 2, d: blockToRequest });
                    }
                    logger.info(`Requested blocks ${currentLocalBlock + 1} to ${currentLocalBlock + batchSize} from peers`);
                }
            }
        }
    } catch (error) {
        logger.error('Error checking network sync status:', error);
    }
};


// Cleanup on exit
process.on('SIGINT', cleanup);

// Public interface - thin delegators
const steemModule = {
    init,
    initSteemSync,
    updateBlockId,
    isInSyncMode: () => syncManager.isInSyncMode(),
    processBlock,
    getLatestSteemBlockNum,
    switchToNextEndpoint,
    updateNetworkBehindBlocks: (count: number) => syncManager.updateBehindBlocks(count),
    getBehindBlocks: () => syncManager.getBehindBlocks(),
    getSyncExitTarget: () => syncManager.getSyncExitTarget(),
    receivePeerSyncStatus: (nodeId: string, status: any) => {
        networkStatus.receivePeerSyncStatus(nodeId, status);
        syncManager.receivePeerSyncStatus(nodeId, status);
    },
    getSyncStatus: () => ({
        isSyncing: syncManager.isInSyncMode(),
        behindBlocks: syncManager.getBehindBlocks()
    }),
    isOnSteemBlock,
    isProcessingBlock: (blockNum: number) => blockProcessor.isProcessingBlock(blockNum),
    getRpcHeightData: () => apiClient.getRpcHeightData(),
    shouldBeLenient: (blockId: number) => syncManager.shouldBeLenient(blockId),
    handlePostSyncReady: (blockId: number) => syncManager.handlePostSyncReady(blockId),
    getLastSyncExitTime: () => syncManager.getLastSyncExitTime(),

    // Delegated methods
    updateLocalSteemState: (localDelay: number, headSteemBlock: number) => networkStatus.updateLocalSteemState(localDelay, headSteemBlock),
    getNetworkOverallBehindBlocks: () => networkStatus.getNetworkOverallBehindBlocks(),
    isNetworkReadyToEnterSyncMode: (localBehind: number, isSyncing: boolean) => networkStatus.isNetworkReadyToEnterSyncMode(localBehind, isSyncing),
    shouldExitSyncMode: async (blockId: number) => await syncManager.shouldExitSyncMode(blockId),
    enterSyncMode: () => syncManager.enterSyncMode(),
    exitSyncMode: (blockId: number, steemBlock: number) => syncManager.exitSyncMode(blockId, steemBlock),
    isNetworkReadyToExitSyncMode: () => syncManager.shouldExitSyncMode(chain?.getLatestBlock()?._id || 0)
};

export default steemModule; 