import { Client as DsteemClient } from 'dsteem';
import logger from './logger.js';
import parseSteemTransactions, { SteemBlock, SteemBlockResult } from './steemParser.js';
import config from './config.js';
import { Block } from './block.js';
import p2p from './p2p.js';
import { chain } from './chain.js';
import transaction from './transaction.js';
interface NetworkSyncStatus {
    highestBlock: number;
    referenceExists: boolean;
    referenceNodeId: string;
    medianBlock?: number;
    nodesInSync?: number;
    totalNodes?: number;
}

interface SyncStatus {
    nodeId: string;
    behindBlocks: number;
    steemBlock: number; // The latest Steem block this node has processed or is aware of for its sidechain state
    isSyncing: boolean;
    blockId: number; // The sidechain block ID of this node
    consensusBlocks: any; // Not entirely clear, assuming it's related to consensus state
    exitTarget: number | null;
    timestamp: number;
}

interface RpcHeightData {
    height: number;
    timestamp: number;
}



// Module variables
let currentSteemBlock = 0;
let processingBlocks: number[] = [];
let isSyncing = false;
let syncInterval: NodeJS.Timeout | null = null;
let behindBlocks = 0;
const MAX_CONSECUTIVE_ERRORS = 20;
const MIN_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 15000;
const CIRCUIT_BREAKER_THRESHOLD = 30;
const PREFETCH_BLOCKS = 5;  // Maximum number of blocks to prefetch at once
const MAX_PREFETCH_BLOCKS = 10;  // Maximum number of blocks to prefetch at once
const SYNC_EXIT_THRESHOLD = 3;   // Exit sync when we're at most this many blocks behind
const DEFAULT_BROADCAST_INTERVAL = 30000; // 30 seconds in normal mode (increased from 10s)
const FAST_BROADCAST_INTERVAL = 5000; // 5 second
const SYNC_ENTRY_QUORUM_PERCENT = (config as any).syncEntryQuorumPercent || 50; // % of reporting peers needed to agree to enter sync
const SYNC_EXIT_QUORUM_PERCENT = (config as any).syncExitQuorumPercent || 60; // Require 60% of nodes to be caught up before exiting sync mode
const MIN_WITNESSES_FOR_QUORUM_CONSIDERATION = (config as any).minWitnessesForQuorumConsideration || 3;

// --- Post-sync cooldown and READY handshake ---
const POST_SYNC_LENIENT_BLOCKS = 5; // Number of blocks to be lenient after sync exit
let postSyncLenientUntil: number | null = null; // Block height until which leniency applies
let readySent = false;

// Track when to exit sync mode
let syncExitTargetBlock: number | null = null;  // Target block to exit sync mode
let consecutiveErrors = 0;
let retryDelay = MIN_RETRY_DELAY;
let circuitBreakerOpen = false;

let blockCache = new Map<number, SteemBlock>();
let prefetchInProgress = false;

let readyToReceiveTransactions = false;

// Add tracking for sync mode exit time
let lastSyncExitTime: number | null = null;

// Track RPC heights with timestamps
const rpcHeightData = new Map<string, RpcHeightData>(); // Store both height and timestamp

// Add new tracking variables at the top
let networkSteemHeights = new Map<string, {
    steemBlock: number;
    behindBlocks: number;
    timestamp: number;
    blockId?: number;
    consensusBlocks?: number;
    isInWarmup?: boolean;
    exitTarget?: number | null;
}>(); // Track each node's latest Steem block height
const STEEM_HEIGHT_EXPIRY = 30000; // Expire Steem heights older than 30 seconds

let networkSyncStatus = new Map<string, SyncStatus>(); // Track other nodes' sync status

// --- Dynamic Sync Status Broadcasting ---
let syncStatusBroadcastInterval: NodeJS.Timeout | null = null;
let lastBroadcastInterval: number | null = null;
let lastBroadcastedSyncStatus: Partial<SyncStatus> = {};
let lastForcedBroadcast = 0;
const FORCED_BROADCAST_INTERVAL = 30000; // 30 seconds backup

const SYNC_BLOCK_FETCH_DELAY = 200; // ms delay between block fetches in sync mode

// Setup multiple endpoints with manual failover
const DEFAULT_STEEM_ENDPOINTS = [
    'https://api.steemit.com'
];

const apiUrls = process.env.STEEM_API
    ? process.env.STEEM_API.split(',').map(url => url.trim())
    : DEFAULT_STEEM_ENDPOINTS;

// Track current endpoint and create initial client
let currentEndpointIndex = 0;
let client = null as any;
const isTestnet = process.env.NODE_ENV === 'development';

client = new DsteemClient(apiUrls[currentEndpointIndex], {
    addressPrefix: 'STM',
    chainId: (config as any).steemChainId || '0000000000000000000000000000000000000000000000000000000000000000',
    timeout: 15000  // Increased timeout for better reliability
});

let nextSteemBlock = 0;
// Map to store peer sync statuses
const peerSyncStatuses: Record<string, SyncStatus> = {};

const SYNC_MODE_BLOCK_FETCH_BATCH = 10; // Number of blocks to fetch at once in sync mode
const NORMAL_MODE_BLOCK_FETCH_BATCH = 5; // Number of blocks to fetch at once in normal mode

const STEEM_HEAD_POLLING_INTERVAL = (config as any).steemHeadPollingInterval || 3000;
const SYNC_MODE_POLLING_INTERVAL = (config as any).syncModePollingInterval || 1000;
let steemBlockPollingInterval: NodeJS.Timeout | null = null;

let statusBroadcastCounter = 0;
const MAX_RAPID_BROADCASTS = 5;

/**
 * Set whether we're ready to receive transactions
 * @param ready - True if ready
 */
const setReadyToReceiveTransactions = (ready: boolean): void => {
    readyToReceiveTransactions = ready;
};

/**
 * Initialize Steem sync
 * @param blockNum - The block number to start syncing from
 */
const initSteemSync = (blockNum: number): void => {
    if (steemBlockPollingInterval) {
        clearInterval(steemBlockPollingInterval);
        steemBlockPollingInterval = null;
    }
    
    getLatestSteemBlockNum().then(latestBlock => {
        if (latestBlock) {
            let lastProcessedSteemBlock = 0;
            const latestChainBlock = chain.getLatestBlock();
            if (latestChainBlock && latestChainBlock.steemBlockNum) {
                lastProcessedSteemBlock = latestChainBlock.steemBlockNum;
            } else if (config.steemStartBlock) {
                lastProcessedSteemBlock = config.steemStartBlock;
            } else {
                lastProcessedSteemBlock = blockNum;
            }

            behindBlocks = Math.max(0, latestBlock - lastProcessedSteemBlock);
            logger.info(`Initialized Steem Sync - ${behindBlocks} behind (Steem: ${latestBlock}, Sidechain Steem Block: ${lastProcessedSteemBlock})`);

            if (behindBlocks > 0) {
                prefetchBlocks(lastProcessedSteemBlock + 1);
            }
            
            updateSteemBlockPolling();
            
            if (behindBlocks > config.steemBlockDelay && !isSyncing) {
                logger.info(`Already ${behindBlocks} blocks behind (threshold ${config.steemBlockDelay}), entering sync mode immediately`);
                enterSyncMode();
            }
        } else {
             logger.warn('Failed to get latest Steem block for initSteemSync, will retry with polling.');
             updateSteemBlockPolling();
        }
    }).catch(err => {
        logger.error('Error initializing behind blocks count in initSteemSync:', err);
        updateSteemBlockPolling();
    });
};

/**
 * Initialize the Steem module
 * @param blockNum - The block number to start syncing from
 */
const init = (blockNum: number): void => {
    nextSteemBlock = blockNum;
    currentSteemBlock = blockNum -1;
    if (syncInterval) clearInterval(syncInterval);
    logger.info('Initializing Steem module for block', nextSteemBlock);
    setReadyToReceiveTransactions(false);
    syncExitTargetBlock = null;
    startSyncStatusBroadcasting();
    readySent = false;

    const networkCheckInterval = setInterval(checkNetworkSyncStatus, 5000);
    process.on('SIGINT', () => {
        clearInterval(networkCheckInterval);
    });

    checkNetworkSyncStatus().then(async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const networkStatus = getNetworkSyncStatus();

        if (!p2p.recovering && networkStatus.referenceExists && networkStatus.referenceNodeId !== 'self') {
            const referenceBlock = networkStatus.highestBlock;
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
                    if (p2p && p2p.sockets && p2p.sockets.length > 0) {
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
            const blockRequestInterval = setInterval(requestBlocks, 1000);
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
    if (apiUrls.length <= 1) return false;
    let bestEndpoint = apiUrls[0];
    let highestBlock = 0;
    for (const [url, data] of rpcHeightData.entries()) {
        if (apiUrls.includes(url) && data.height > highestBlock) {
            highestBlock = data.height;
            bestEndpoint = url;
        }
    }
    if (bestEndpoint !== client.address) {
        logger.info(`Switching to better Steem API endpoint: ${bestEndpoint}`);
        client = new DsteemClient(bestEndpoint, {
            addressPrefix: 'STM',
            chainId: (config as any).steemChainId || '0000000000000000000000000000000000000000000000000000000000000000',
            timeout: 15000
        });
        return true;
    }
    currentEndpointIndex = (currentEndpointIndex + 1) % apiUrls.length;
    const newEndpoint = apiUrls[currentEndpointIndex];
    logger.info(`Switching to next Steem API endpoint: ${newEndpoint}`);
    client = new DsteemClient(newEndpoint, {
        addressPrefix: 'STM',
        chainId: (config as any).steemChainId || '0000000000000000000000000000000000000000000000000000000000000000',
        timeout: 15000
    });
    return true;
};

const updateBlockId = (blockNum: number): void => {
    currentSteemBlock = blockNum;
};

function stopSyncStatusBroadcasting(): void {
    if (syncStatusBroadcastInterval) {
        clearInterval(syncStatusBroadcastInterval);
        syncStatusBroadcastInterval = null;
        lastBroadcastInterval = null;
    }
}

function startSyncStatusBroadcasting(): void {
    stopSyncStatusBroadcasting();
    const jitter = Math.floor(Math.random() * 2000);
    syncStatusBroadcastInterval = setInterval(broadcastSyncStatusLoop, DEFAULT_BROADCAST_INTERVAL + jitter);
    lastBroadcastInterval = DEFAULT_BROADCAST_INTERVAL;
    broadcastSyncStatusLoop();
}

function broadcastSyncStatusLoop(): void {
    if (!(p2p.nodeId && p2p.sockets && p2p.sockets.length > 0)) {
        setTimeout(broadcastSyncStatusLoop, 1000);
        return;
    }
    const statusToBroadcast: SyncStatus = {
        nodeId: p2p.nodeId?.pub || 'unknown',
        behindBlocks: behindBlocks,
        steemBlock: currentSteemBlock,
        isSyncing: isSyncing,
        blockId: chain.getLatestBlock()?._id || 0,
        consensusBlocks: {}, 
        exitTarget: syncExitTargetBlock,
        timestamp: Date.now()
    };
    const targetInterval = isSyncing ? FAST_BROADCAST_INTERVAL : DEFAULT_BROADCAST_INTERVAL;
    const significantChange =
        statusToBroadcast.isSyncing !== lastBroadcastedSyncStatus.isSyncing ||
        Math.abs((statusToBroadcast.behindBlocks || 0) - (lastBroadcastedSyncStatus.behindBlocks || 0)) > 2 ||
        statusToBroadcast.exitTarget !== lastBroadcastedSyncStatus.exitTarget;
    const now = Date.now();
    if (significantChange || (now - lastForcedBroadcast) > targetInterval) {
        p2p.broadcastSyncStatus(statusToBroadcast);
        lastBroadcastedSyncStatus = { ...statusToBroadcast };
        lastForcedBroadcast = now;
    }
    if (syncStatusBroadcastInterval) clearTimeout(syncStatusBroadcastInterval);
    const checkFrequency = Math.max(1000, targetInterval / 2);
    syncStatusBroadcastInterval = setTimeout(broadcastSyncStatusLoop, checkFrequency);
}

/** Original enterSyncMode */
function enterSyncMode(): void {
    if (isSyncing) {
        logger.debug('Already in sync mode, ignoring enterSyncMode call');
        return;
    }
    logger.info('Entering sync mode');
    isSyncing = true;
    syncExitTargetBlock = null;
    prefetchBlocks(currentSteemBlock + 1);
    updateSteemBlockPolling();
    startSyncStatusBroadcasting(); // Ensures more frequent broadcasts
    readySent = false;
    statusBroadcastCounter = 0;
    // Broadcast current status immediately
    if (p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
         const currentStatus: SyncStatus = {
            nodeId: p2p.nodeId?.pub || 'unknown',
            behindBlocks: behindBlocks,
            steemBlock: currentSteemBlock,
            isSyncing: true, // Explicitly true
            blockId: chain.getLatestBlock()?._id || 0,
            consensusBlocks: {},
            exitTarget: null,
            timestamp: Date.now()
        };
        p2p.broadcastSyncStatus(currentStatus);
    }
}

/** Original exitSyncMode */
function exitSyncMode(currentBlockId: number, currentSteemBlockNum: number): void {
    if (!isSyncing) {
        logger.debug('Not in sync mode, ignoring exitSyncMode call');
        return;
    }
    logger.info(`Exiting sync mode at block ${currentBlockId} (Steem block: ${currentSteemBlockNum})`);
    isSyncing = false;
    updateSteemBlockPolling();
    postSyncLenientUntil = currentBlockId + POST_SYNC_LENIENT_BLOCKS;
    logger.info(`Setting lenient validation until block ${postSyncLenientUntil}`);
    lastSyncExitTime = Date.now();
    
    // Broadcast exit status immediately and ensure it's received
    if (p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
        const exitStatus: SyncStatus = {
            nodeId: p2p.nodeId?.pub || 'unknown',
            behindBlocks: behindBlocks, // Reflect current behindBlocks at exit
            steemBlock: currentSteemBlockNum,
            isSyncing: false, // Explicitly false
            blockId: currentBlockId,
            consensusBlocks: {},
            exitTarget: null, // Clear any previous exit target
            timestamp: Date.now()
        };
        p2p.broadcastSyncStatus(exitStatus);
        // Rapid broadcasts for exit
        statusBroadcastCounter = 0;
        const rapidBroadcastExit = () => {
            if (statusBroadcastCounter < MAX_RAPID_BROADCASTS && !isSyncing) { // also check !isSyncing
                p2p.broadcastSyncStatus(exitStatus); // re-broadcast same exit status
                statusBroadcastCounter++;
                setTimeout(rapidBroadcastExit, 500);
            }
        };
        setTimeout(rapidBroadcastExit, 250); // Start slightly faster
    }
    // Return to normal (potentially slower) broadcast interval AFTER sending immediate exit signals
    startSyncStatusBroadcasting();
}

function handlePostSyncReady(blockId: number): void {
    if (!readySent && !isSyncing && postSyncLenientUntil && blockId <= postSyncLenientUntil) {
        if (p2p && p2p.sockets && p2p.sockets.length > 0) {
            // p2p.broadcast({ t: 12 }); // Example: READY message type
            logger.info(`Sent READY handshake to peers at block ${blockId}`);
        }
        readySent = true;
    }
}

function shouldBeLenient(blockId: number): boolean {
    return !!postSyncLenientUntil && blockId <= postSyncLenientUntil;
}

const updateNetworkBehindBlocks = (newValue: number): void => {
    behindBlocks = newValue;
};

const isInSyncMode = (): boolean => {
    return isSyncing;
};

/** Original isNetworkReadyToExitSyncMode */
const isNetworkReadyToExitSyncMode = (): boolean => {
    const now = Date.now();
    let nodesReadyToExit = 0;
    let consideredNodes = 0;
    const witnessAccounts = new Set(chain.schedule.active_witnesses || []);
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatus.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY) {
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
            let isRelevantPeer = (witnessAccounts.size === 0) || 
                                 (peerAccount && witnessAccounts.has(peerAccount)) ||
                                 ((config as any).activeWitnesses || []).includes(peerAccount);

            if (isRelevantPeer) {
                consideredNodes++;
                if ((!status.isSyncing && status.behindBlocks <= SYNC_EXIT_THRESHOLD) ||
                    (status.isSyncing && status.behindBlocks <= SYNC_EXIT_THRESHOLD) || 
                    (status.exitTarget !== null && status.exitTarget <= (chain.getLatestBlock()?._id || 0) + SYNC_EXIT_THRESHOLD )) {
                    nodesReadyToExit++;
                }
            }
        }
    });
    
    const selfAccount = process.env.STEEM_ACCOUNT || "";
    const selfIsWitnessOrNoWitnessList = witnessAccounts.size === 0 || 
                                       witnessAccounts.has(selfAccount) || 
                                       ((config as any).activeWitnesses || []).includes(selfAccount);

    if (isSyncing && selfIsWitnessOrNoWitnessList) {
         let selfAlreadyCountedAsPeer = false;
         if (p2p.nodeId?.pub && networkSyncStatus.has(p2p.nodeId.pub)) {
             const selfStatusInMap = networkSyncStatus.get(p2p.nodeId.pub)!;
             const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(p2p.nodeId.pub) : null;
             let isRelevantPeer = (witnessAccounts.size === 0) || (peerAccount && witnessAccounts.has(peerAccount)) || ((config as any).activeWitnesses || []).includes(peerAccount);
             if (isRelevantPeer) selfAlreadyCountedAsPeer = true;
         }

         if (!selfAlreadyCountedAsPeer) {
            consideredNodes++; 
            if (behindBlocks <= SYNC_EXIT_THRESHOLD) {
                nodesReadyToExit++;
            }
         } else {
            // Self was already processed as a peer. Ensure its current status didn't make it "not ready" if it should be.
            // This edge case is complex. Primarily rely on timely broadcasts of local status.
            // If the map says self is NOT ready, but local IS, and self was only one holding back quorum...
            // This is an unlikely scenario if broadcasts are frequent enough.
         }
    }
    
    if (consideredNodes === 0) {
        return behindBlocks <= SYNC_EXIT_THRESHOLD; 
    }

    const percentageReady = (nodesReadyToExit / consideredNodes) * 100;
    return percentageReady >= SYNC_EXIT_QUORUM_PERCENT;
};

/** Original shouldExitSyncMode */
const shouldExitSyncMode = (currentBlockId: number): boolean => {
    if (!isSyncing) return false;
    const localCaughtUp = behindBlocks <= SYNC_EXIT_THRESHOLD;
    if (!localCaughtUp) {
        return false;
    }
    if (isNetworkReadyToExitSyncMode()) { // Calls the restored/original isNetworkReadyToExitSyncMode
        logger.info(`Local node caught up and network is ready to exit sync mode at block ${currentBlockId}.`);
        return true;
    } else {
        // logger.debug(`Local node caught up, but network not yet ready to exit sync mode at block ${currentBlockId}.`);
        return false;
    }
};

const prefetchBlocks = async (blockNum: number): Promise<void> => {
    if (prefetchInProgress || circuitBreakerOpen) return;
    prefetchInProgress = true;
    try {
        let currentBlockToProcess = blockNum || config.steemStartBlock; // Use a different var name
        const latestSteemBlock = await getLatestSteemBlockNum();
        if (!latestSteemBlock) {
            logger.warn(`Could not fetch latest steem block for prefetch`);
            prefetchInProgress = false;
            return;
        }
        const localBehind = latestSteemBlock - currentBlockToProcess; // Use new var
        behindBlocks = localBehind; // Update global
        if (localBehind <= 0) {
            logger.debug('Already caught up with Steem, no blocks to prefetch');
            prefetchInProgress = false;
            return;
        }
        let blocksToPrefetchCount; // Use new var
        if (isSyncing) {
            blocksToPrefetchCount = Math.min(SYNC_MODE_BLOCK_FETCH_BATCH, localBehind);
        } else {
            blocksToPrefetchCount = Math.min(NORMAL_MODE_BLOCK_FETCH_BATCH, localBehind);
        }
        if (localBehind > MAX_PREFETCH_BLOCKS) { // If very far, be more aggressive
            blocksToPrefetchCount = Math.min(MAX_PREFETCH_BLOCKS, localBehind);
        }
        logger.debug(`Prefetching ${blocksToPrefetchCount} blocks starting from ${currentBlockToProcess} (behind: ${localBehind})`);
        let missedBlocksCount = 0;
        let firstBlockProcessed = false; // Use new var
        for (let i = 0; i < blocksToPrefetchCount && !circuitBreakerOpen; i++) {
            const blockToFetchNum = currentBlockToProcess + i; // Use new var
            if (processingBlocks.includes(blockToFetchNum) || blockCache.has(blockToFetchNum)) {
                continue;
            }
            try {
                const steemBlockData = await client.database.getBlock(blockToFetchNum); // Use new var
                if (steemBlockData) {
                    blockCache.set(blockToFetchNum, steemBlockData as any);
                    firstBlockProcessed = true;
                } else {
                    missedBlocksCount++;
                    logger.warn(`No data returned for Steem block ${blockToFetchNum}`);
                    if (i === 0 && !firstBlockProcessed && consecutiveErrors > 3) {
                        logger.warn(`Skipping problematic block ${blockToFetchNum} after multiple failures during prefetch`);
                        nextSteemBlock = blockToFetchNum + 1; // Adjust main fetch pointer
                        resetConsecutiveErrors(); // Give it a fresh start
                    } else {
                        incrementConsecutiveErrors();
                    }
                }
            } catch (error) {
                missedBlocksCount++;
                incrementConsecutiveErrors();
                logger.warn(`Failed to prefetch Steem block ${blockToFetchNum}:`, error);
                if (i === 0 && !firstBlockProcessed && consecutiveErrors > 5) {
                    logger.warn(`Moving past problematic block ${blockToFetchNum} after ${consecutiveErrors} errors during prefetch`);
                    nextSteemBlock = blockToFetchNum + 1;
                    resetConsecutiveErrors();
                }
            }
            const fetchDelayMs = isSyncing ? SYNC_BLOCK_FETCH_DELAY : SYNC_BLOCK_FETCH_DELAY * 2; // Use new var
            await new Promise(resolve => setTimeout(resolve, fetchDelayMs));
        }
        if (missedBlocksCount > 0 && missedBlocksCount >= blocksToPrefetchCount / 2) {
            logger.warn(`Missed ${missedBlocksCount}/${blocksToPrefetchCount} blocks during prefetch, switching RPC endpoint`);
            switchToNextEndpoint();
        }
        if (blockCache.size > blocksToPrefetchCount * 2) { // Trim cache
            const keysArray = Array.from(blockCache.keys()).sort((a, b) => a - b);
            const keysToDelete = keysArray.slice(0, blockCache.size - blocksToPrefetchCount);
            keysToDelete.forEach(key => blockCache.delete(key));
        }
        if (localBehind > config.steemBlockDelay && !isSyncing) {
            logger.info(`Behind ${localBehind} blocks after prefetch, automatically entering sync mode`);
            enterSyncMode();
        }
        if (isSyncing && localBehind <= SYNC_EXIT_THRESHOLD && shouldExitSyncMode(chain?.getLatestBlock()?._id || 0)) {
            exitSyncMode(chain?.getLatestBlock()?._id || 0, currentSteemBlock); // currentSteemBlock should be updated by processBlock
        }
    } catch (error) {
        logger.error('Error in prefetchBlocks:', error);
    } finally {
        prefetchInProgress = false;
    }
};

const processBlock = async (blockNum: number): Promise<SteemBlockResult | null> => {
    if (p2p.recovering) {
        logger.debug('Skipping Steem block processing - node not ready to receive transactions yet');
        return Promise.resolve(null);
    }
    // currentSteemBlock here refers to the last successfully processed Steem block by the sidechain
    const lastProcessedSteemBlockBySidechain = chain.getLatestBlock()?.steemBlockNum || 0; 
    if (blockNum !== lastProcessedSteemBlockBySidechain + 1) {
        logger.warn(`Attempting to process Steem block ${blockNum} out of order. Expected: ${lastProcessedSteemBlockBySidechain + 1}. Skipping.`);
        // If significantly ahead, might indicate a need to prefetch or adjust nextSteemBlock
        if (blockNum > lastProcessedSteemBlockBySidechain + 1 + PREFETCH_BLOCKS) {
            logger.warn(`processBlock called with ${blockNum}, far ahead of last processed ${lastProcessedSteemBlockBySidechain}. Prefetch might be needed.`);
        }
        return Promise.resolve(null);
    }

    if (processingBlocks.includes(blockNum)) {
        logger.debug(`Block ${blockNum} is already being processed`);
        return Promise.resolve(null);
    }
    processingBlocks.push(blockNum);
    try {
        let steemBlock = blockCache.get(blockNum);
        if (!steemBlock) {
            try {
                const rawSteemBlock = await client.database.getBlock(blockNum);
                if (rawSteemBlock) {
                    steemBlock = {
                        transactions: rawSteemBlock.transactions || [],
                        timestamp: rawSteemBlock.timestamp
                    };
                    blockCache.set(blockNum, steemBlock);
                    if (blockCache.size > PREFETCH_BLOCKS * 10) {
                        const keysToDelete = Array.from(blockCache.keys()).slice(0, PREFETCH_BLOCKS);
                        keysToDelete.forEach(key => blockCache.delete(key));
                    }
                }
            } catch (error) {
                incrementConsecutiveErrors();
                logger.error(`Failed to fetch Steem block ${blockNum} in processBlock:`, error);
                processingBlocks = processingBlocks.filter(b => b !== blockNum);
                return Promise.reject(error); // Propagate error for retry logic if any
            }
        }
        if (!steemBlock) {
            logger.warn(`Steem block ${blockNum} not found in processBlock after fetch attempt`);
            processingBlocks = processingBlocks.filter(b => b !== blockNum);
            return Promise.resolve(null); // Or reject, depending on desired retry behavior
        }
        const steemBlockResult = await parseSteemTransactions(steemBlock, blockNum);
        // currentSteemBlock = Math.max(currentSteemBlock, blockNum); // This was causing issues. currentSteemBlock should reflect sidechain's state.
                                                              // The sidechain's latest Steem block is updated when a sidechain block is made.
        resetConsecutiveErrors();
        if (steemBlockResult.transactions.length > 0) {
            transaction.addToPool(steemBlockResult.transactions);
        }
        processingBlocks = processingBlocks.filter(b => b !== blockNum);
        return Promise.resolve(steemBlockResult);
    } catch (error) {
        incrementConsecutiveErrors();
        logger.error(`Error processing Steem block ${blockNum}:`, error);
        processingBlocks = processingBlocks.filter(b => b !== blockNum);
        return Promise.reject(error);
    }
};

const getNetworkSyncStatus = (): NetworkSyncStatus => {
    const now = Date.now();
    let highestKnownBlock = chain.getLatestBlock()?._id || 0;
    let refNodeId = 'self';
    let hasReference = false;
    const activePeerBlocks: number[] = [];
    let nodesInSyncCount = 0;
    let totalConsideredNodes = 0;
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatus.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && (now - status.timestamp < STEEM_HEIGHT_EXPIRY * 2)) {
            totalConsideredNodes++;
            if (status.blockId > highestKnownBlock) {
                highestKnownBlock = status.blockId;
                refNodeId = nodeId;
                hasReference = true;
            }
            activePeerBlocks.push(status.blockId);
            // A node is "in sync" if it's not explicitly syncing OR if it is syncing but very close to caught up
            if (!status.isSyncing || (status.isSyncing && status.behindBlocks <= SYNC_EXIT_THRESHOLD)) {
                nodesInSyncCount++;
            }
        }
    });
    // Consider self for sync count
    if (!isSyncing || (isSyncing && behindBlocks <= SYNC_EXIT_THRESHOLD)) {
        if (totalConsideredNodes === 0 || !activePeerNodeIds.has(p2p.nodeId?.pub || '')) { // Avoid double counting if self is a peer
             // nodesInSyncCount++; // This might inflate if self is the only node.
        }
    }
    // If no peers reporting, reference doesn't exist for external nodes
    if (totalConsideredNodes === 0 && !p2p.recovering ) { // && !activePeerNodeIds.has(p2p.nodeId?.pub || '')
         hasReference = false; // No *external* reference
    }

    const median = activePeerBlocks.length > 0 ? getMedian(activePeerBlocks) : highestKnownBlock;
    return {
        highestBlock: highestKnownBlock,
        referenceExists: hasReference,
        referenceNodeId: refNodeId,
        medianBlock: median,
        nodesInSync: nodesInSyncCount, // May need adjustment based on how "totalNodes" is counted
        totalNodes: totalConsideredNodes > 0 ? totalConsideredNodes : 1 // Avoid division by zero; if 0, implies self is 1.
    };
};

const getMedian = (numbers: number[]): number => {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
};

const getValidRpcHeights = (): Map<string, number> => {
    const now = Date.now();
    const validHeights = new Map<string, number>();
    for (const [url, data] of rpcHeightData.entries()) {
        if (now - data.timestamp < 60000) {
            validHeights.set(url, data.height);
        }
    }
    return validHeights;
};

const calculateRetryDelay = (): number => {
    return Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
};

const incrementConsecutiveErrors = (): void => {
    consecutiveErrors++;
    retryDelay = calculateRetryDelay();
    if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD && !circuitBreakerOpen) {
        circuitBreakerOpen = true;
        logger.error(`Circuit breaker opened after ${consecutiveErrors} consecutive errors. Forcing sync mode.`);
        if(!isSyncing) enterSyncMode(); // Force sync mode
    }
};

const resetConsecutiveErrors = (): void => {
    if (consecutiveErrors > 0) { // Only log if there were errors
        logger.debug(`Reset consecutive errors counter from ${consecutiveErrors}`);
        consecutiveErrors = 0;
        retryDelay = MIN_RETRY_DELAY;
    }
    if (circuitBreakerOpen) {
        logger.info('Circuit breaker closed.');
        circuitBreakerOpen = false;
    }
};

const fetchMissingBlock = async (blockNum: number): Promise<SteemBlock | undefined> => {
    logger.info('Fetching missing Steem block:', blockNum)
    // prefetchInProgress = true; // Not strictly prefetching, but similar single block fetch.
    try {
        let retries = 5;
        let rawSteemBlock = null;
        while (retries > 0) {
            try {
                rawSteemBlock = await client.database.getBlock(blockNum);
                if (rawSteemBlock) break;
                // If null but no error, it means block doesn't exist or RPC is lagging.
                logger.warn(`getBlock(${blockNum}) returned null. Retries left: ${retries - 1}`);
                 await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
            } catch (err) {
                logger.warn(`Error fetching block ${blockNum} (${retries} retries left): ${err}`)
                if (retries <= 3) { // Try switching endpoint after a few fails on current one
                    switchToNextEndpoint();
                    logger.info(`Switched RPC endpoint while fetching missing block ${blockNum}`);
                }
                await new Promise(resolve => setTimeout(resolve, 2000 * (5 - retries + 1) )); // Exponential backoff for retries
            }
            retries--;
        }
        if (rawSteemBlock) {
            const steemBlock: SteemBlock = {
                transactions: rawSteemBlock.transactions || [],
                timestamp: rawSteemBlock.timestamp
            };
            blockCache.set(blockNum, steemBlock);
            logger.debug('Successfully fetched and cached missing block:', blockNum);
            return steemBlock;
        } else {
            logger.error('Failed to fetch missing block after retries:', blockNum);
            return undefined;
        }
    } catch (err) {
        logger.error('Error in fetchMissingBlock function for block:', blockNum, err);
        return undefined;
    } finally {
        // prefetchInProgress = false;
    }
};

const getLatestSteemBlockNum = async (): Promise<number | null> => {
    try {
        const now = Date.now();
        let highestCachedBlock = 0;
        let mostRecentCacheTime = 0;
        for (const data of rpcHeightData.values()) { // Iterate values directly
            if (now - data.timestamp < 10000 && data.height > highestCachedBlock) { // Use cache if <10s old
                highestCachedBlock = data.height;
                mostRecentCacheTime = data.timestamp;
            }
        }
        if (highestCachedBlock > 0 && mostRecentCacheTime > now - 10000) {
            return highestCachedBlock;
        }
        const dynGlobalProps = await client.database.getDynamicGlobalProperties();
        if (dynGlobalProps && dynGlobalProps.head_block_number) {
            rpcHeightData.set(client.address, {
                height: dynGlobalProps.head_block_number,
                timestamp: Date.now() // Use fresh timestamp
            });
            return dynGlobalProps.head_block_number;
        } else {
            throw new Error('Invalid response from getDynamicGlobalProperties');
        }
    } catch (error) {
        logger.warn('Error getting latest Steem block number from primary endpoint:', error);
        if (switchToNextEndpoint()) {
            try {
                logger.info('Trying alternate endpoint for getLatestSteemBlockNum');
                const dynGlobalProps = await client.database.getDynamicGlobalProperties();
                if (dynGlobalProps && dynGlobalProps.head_block_number) {
                    rpcHeightData.set(client.address, {
                        height: dynGlobalProps.head_block_number,
                        timestamp: Date.now()
                    });
                    return dynGlobalProps.head_block_number;
                }
            } catch (retryError) {
                logger.error('Error with alternate endpoint for getLatestSteemBlockNum:', retryError);
            }
        }
        // Fallback to highest valid cached RPC height if direct calls fail
        if (rpcHeightData.size > 0) {
            const validHeights = Array.from(rpcHeightData.values())
                .filter(data => Date.now() - data.timestamp < 60000) // Cache < 1 min old
                .map(data => data.height);
            if (validHeights.length > 0) {
                const maxCachedHeight = Math.max(...validHeights);
                if (maxCachedHeight > 0) {
                    logger.info(`Using cached highest RPC block height as fallback: ${maxCachedHeight}`);
                    return maxCachedHeight;
                }
            }
        }
        return null;
    }
};

const checkNetworkSyncStatus = async (): Promise<void> => {
    try {
        const latestSteemBlock = await getLatestSteemBlockNum();
        if (!latestSteemBlock) {
            logger.warn('Failed to get latest Steem block number for network status check');
            return;
        }
        // Use sidechain's last processed Steem block
        const lastProcessedSteemBlockOnSidechain = chain?.getLatestBlock()?.steemBlockNum || 0;
        behindBlocks = Math.max(0, latestSteemBlock - lastProcessedSteemBlockOnSidechain);
        
        const now = Date.now();
        for (const [nodeId, status] of networkSteemHeights.entries()) {
            if (now - status.timestamp > 120000) { // 2 minutes expiry
                networkSteemHeights.delete(nodeId);
            }
        }
        const networkStatus = getNetworkSyncStatus();
        logger.debug(`Network sync status: Highest Sidechain Block: ${networkStatus.highestBlock}, Ref Node: ${networkStatus.referenceNodeId}, Nodes In Sync: ${networkStatus.nodesInSync}/${networkStatus.totalNodes}, Median Sidechain Block: ${networkStatus.medianBlock}, Our Sidechain Block: ${chain?.getLatestBlock()?._id || 0}, Behind Steem: ${behindBlocks} blocks`);
        
        if (networkStatus.referenceExists && 
            networkStatus.referenceNodeId !== 'self' &&
            networkStatus.highestBlock > (chain?.getLatestBlock()?._id || 0) + 10) { // 10 blocks behind network
            logger.warn(`Significantly behind network: our block ${chain?.getLatestBlock()?._id || 0} vs network ${networkStatus.highestBlock}`);
            if (!p2p.recovering && !isSyncing) { // Only if not already recovering or syncing
                logger.info('Requesting recent blocks from network to catch up with sidechain peers.');
                if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                    const currentLocalBlock = chain?.getLatestBlock()?._id || 0;
                    const blocksToCatchup = networkStatus.highestBlock - currentLocalBlock;
                    const batchSize = Math.min(10, blocksToCatchup);
                    for (let i = 0; i < batchSize; i++) {
                        const blockToRequest = currentLocalBlock + i + 1;
                        p2p.broadcast({ t: 2, d: blockToRequest }); // QUERY_BLOCK
                    }
                    logger.info(`Requested blocks ${currentLocalBlock + 1} to ${currentLocalBlock + batchSize} from peers`);
                }
            }
        }
    } catch (error) {
        logger.error('Error checking network sync status:', error);
    }
};

const receivePeerSyncStatus = (nodeId: string, status: SyncStatus): void => {
    if (!status || typeof status.behindBlocks !== 'number' || typeof status.isSyncing !== 'boolean' || typeof status.steemBlock !== 'number') {
        logger.warn(`Received malformed sync status from ${nodeId}:`, status);
        return;
    }
    networkSyncStatus.set(nodeId, { ...status, nodeId, timestamp: Date.now() });
    // Prune old statuses
    const now = Date.now();
    networkSyncStatus.forEach((s, id) => {
        if (now - s.timestamp > STEEM_HEIGHT_EXPIRY * 4) { // Increased expiry for pruning, e.g. 2 mins
            networkSyncStatus.delete(id);
        }
    });
};

const getSyncStatus = (): { isSyncing: boolean; behindBlocks: number } => {
    return {
        isSyncing,
        behindBlocks
    };
};

/** Restored isOnSteemBlock */
const isOnSteemBlock = async (block: Block): Promise<boolean> => {
    try {
        logger.debug(`Validating transactions in block ${block._id} against Steem block ${block.steemBlockNum}`);
        let steemBlockData = blockCache.get(block.steemBlockNum);

        if (!steemBlockData) {
            logger.warn(`Steem block ${block.steemBlockNum} not found in cache for validation, attempting to fetch it`);
            steemBlockData = await fetchMissingBlock(block.steemBlockNum);
            if (!steemBlockData) {
                logger.error(`Could not fetch Steem block ${block.steemBlockNum} for validation after attempts`);
                return false; // Critical: cannot validate if Steem block is unavailable
            }
            logger.debug(`Successfully fetched Steem block ${block.steemBlockNum} with ${steemBlockData.transactions.length} transactions for validation`);
        }

        if (!block.txs || block.txs.length === 0) {
            logger.debug(`Block ${block._id} has no transactions, skipping Steem validation.`);
            return true;
        }

        logger.debug(`Validating ${block.txs.length} transactions in block ${block._id} against Steem block ${block.steemBlockNum}`);

        for (let i = 0; i < block.txs.length; i++) {
            const tx = block.txs[i];
            if (typeof tx.type !== 'string' || tx.type !== 'custom_json' || !tx.data || tx.data.id !== 'sidechain') {
                logger.debug(`Block ${block._id}, tx #${i} (hash: ${tx.hash || 'N/A'}): Not a 'sidechain' custom_json. Skipping Steem validation.`);
                continue; // Only validate 'sidechain' custom_json transactions against Steem
            }

            let foundOnSteem = false;
            for (let steemTx of steemBlockData.transactions) {
                try {
                    for (let op of steemTx.operations) {
                        if (!Array.isArray(op) || op.length < 2 || typeof op[0] !== 'string') continue;
                        const opType = op[0];
                        const opData = op[1] as any;
                        if (opType !== 'custom_json' || !opData || typeof opData !== 'object' || !opData.id || typeof opData.json !== 'string') continue;

                        if (opData.id === 'sidechain') {
                            try {
                                const jsonData = JSON.parse(opData.json);
                                if (jsonData &&
                                    jsonData.contract === (tx.data?.contract || '') &&
                                    JSON.stringify(jsonData.payload) === JSON.stringify(tx.data?.payload || {})) {
                                    foundOnSteem = true;
                                    logger.debug(`Block ${block._id}, tx #${i} (hash: ${tx.hash}): Found matching transaction in Steem block ${block.steemBlockNum}`);
                                    break; 
                                }
                            } catch (parseErr) {
                                logger.error(`Error parsing JSON in Steem operation for block ${block.steemBlockNum}, tx ${tx.hash}:`, parseErr);
                            }
                        }
                    }
                    if (foundOnSteem) break;
                } catch (txErr) {
                    logger.error(`Error processing transaction in Steem block ${block.steemBlockNum} during validation of block ${block._id}:`, txErr);
                }
            }

            if (!foundOnSteem) {
                logger.error(`Block ${block._id}, tx #${i} (hash: ${tx.hash}): Transaction NOT FOUND in Steem block ${block.steemBlockNum}`);
                return false; // Transaction missing on Steem, block is invalid
            }
        }
        logger.info(`Block ${block._id}: All ${block.txs.filter(t => t.data?.id === 'sidechain').length} 'sidechain' transactions successfully validated against Steem block ${block.steemBlockNum}`);
        return true;
    } catch (error) {
        logger.error(`Critical error validating block ${block._id} against Steem block ${block.steemBlockNum}:`, error);
        return false; // General error during validation
    }
};

/** Restored getBehindBlocks */
const getBehindBlocks = (): number => {
    return behindBlocks;
};

/** Restored getSyncExitTarget */
const getSyncExitTarget = (): number | null => {
    return syncExitTargetBlock;
};

/**
 * Get the timestamp of the last sync mode exit.
 * @returns {number | null} The timestamp or null if never exited.
 */
const getLastSyncExitTime = (): number | null => {
    return lastSyncExitTime;
};

function updateSteemBlockPolling(): void {
    if (steemBlockPollingInterval) {
        clearInterval(steemBlockPollingInterval);
        steemBlockPollingInterval = null;
    }
    let interval;
    if (isSyncing) {
        interval = SYNC_MODE_POLLING_INTERVAL;
    } else if (behindBlocks > 0) { // If behind but not syncing, poll more frequently than normal but less than sync
        interval = Math.max(SYNC_MODE_POLLING_INTERVAL, Math.min(STEEM_HEAD_POLLING_INTERVAL, STEEM_HEAD_POLLING_INTERVAL - (behindBlocks * 100)));
    } else { // Caught up
        interval = STEEM_HEAD_POLLING_INTERVAL * 2; // Poll less frequently when caught up
    }
    const jitter = Math.floor(Math.random() * 500);
    const finalInterval = Math.max(500, interval + jitter); // Ensure interval is not too small

    steemBlockPollingInterval = setInterval(async () => {
        try {
            // Smart skipping: if not syncing, caught up, and few peers or peers are also caught up.
            if (!isSyncing && behindBlocks === 0 && Math.random() > 0.7) { 
                 const networkState = getNetworkSyncStatus(); // Check if network is also calm
                 if(networkState.totalNodes === 0 || (networkState.nodesInSync === networkState.totalNodes && networkState.medianBlock !== undefined && networkState.medianBlock >= (chain.getLatestBlock()?._id || 0) -1 ) ){
                    logger.debug('Skipping Steem block check - system appears stable and caught up.');
                    return;
                 }
            }
            
            const latestBlockOnSteem = await getLatestSteemBlockNum(); // Renamed for clarity
            if (latestBlockOnSteem) {
                const lastSteemBlockInSidechain = chain?.getLatestBlock()?.steemBlockNum || 0; // Renamed
                const newBehindBlocks = Math.max(0, latestBlockOnSteem - lastSteemBlockInSidechain);
                
                if (newBehindBlocks !== behindBlocks) {
                    // logger.debug(`Steem behind count changed: ${behindBlocks} -> ${newBehindBlocks} (Steem: ${latestBlockOnSteem}, Sidechain: ${lastSteemBlockInSidechain})`);
                    behindBlocks = newBehindBlocks; // Update global
                    // Potentially adjust polling frequency if change is significant
                    if (Math.abs(newBehindBlocks - behindBlocks) > SYNC_EXIT_THRESHOLD + 2 ) { // If change is more than a few blocks
                        updateSteemBlockPolling(); // Re-evaluate interval
                        return; 
                    }
                }
                
                // Entry logic
                const entryThreshold = (config as any).steemBlockDelay || 10;
                if (behindBlocks > entryThreshold && !isSyncing) {
                     if(isNetworkReadyToEnterSyncMode(behindBlocks)){
                        logger.info(`Local node ${behindBlocks} blocks behind Steem (threshold ${entryThreshold}) AND network ready. Entering sync mode.`);
                        enterSyncMode();
                     } else {
                        logger.info(`Local node ${behindBlocks} blocks behind Steem. Network not yet ready for sync mode.`);
                     }
                }
                
                // Exit logic
                if (isSyncing && behindBlocks <= SYNC_EXIT_THRESHOLD) {
                    if (shouldExitSyncMode(chain?.getLatestBlock()?._id || 0)) { // Calls the corrected shouldExitSyncMode
                        exitSyncMode(chain?.getLatestBlock()?._id || 0, lastSteemBlockInSidechain); // Pass current sidechain's steem block
                    }
                }
                
                // Trigger prefetch if behind but not already prefetching
                if (behindBlocks > 0 && !prefetchInProgress && !isSyncing) { // Only prefetch if not already syncing (sync has its own prefetch)
                    prefetchBlocks(lastSteemBlockInSidechain + 1);
                }
            }
        } catch (error) {
            logger.error('Error in Steem block polling:', error);
        }
    }, finalInterval);
    logger.info(`Steem block polling interval set to ${finalInterval}ms (Syncing: ${isSyncing}, Behind: ${behindBlocks})`);
}

process.on('SIGINT', () => {
    if (steemBlockPollingInterval) clearInterval(steemBlockPollingInterval);
    if (syncStatusBroadcastInterval) clearInterval(syncStatusBroadcastInterval);
});

const updateLocalSteemState = (localDelay: number, headSteemBlock: number): void => {
    behindBlocks = localDelay;
    // currentSteemBlock should reflect the latest Steem block *incorporated into the sidechain*,
    // not just the head Steem block minus delay. It's updated via sidechain block production.
    // If needed, chain.ts can pass its latest block's steemBlockNum.
};

const getNetworkOverallBehindBlocks = (): { maxBehind: number; medianBehind: number; numReporting: number; numWitnessesReporting: number; witnessesBehindThreshold: number } => {
    const now = Date.now();
    const relevantBehindValues: number[] = [];
    const witnessSteemAccounts = new Set(chain.schedule.active_witnesses || (config as any).activeWitnesses || []);
    let witnessesReportingCount = 0;
    let witnessesConsideredBehindCount = 0;
    const behindThresholdForWitness = (config as any).steemBlockDelayWitnessLagThreshold || ((config as any).steemBlockDelay || 10);
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatus.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY * 2) { // Consider statuses up to 60s old
            relevantBehindValues.push(status.behindBlocks);
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null; 
            if (peerAccount && witnessSteemAccounts.has(peerAccount)) {
                witnessesReportingCount++;
                if (status.behindBlocks > behindThresholdForWitness) {
                    witnessesConsideredBehindCount++;
                }
            } else if (witnessSteemAccounts.size === 0) { 
                // If no witness list, any reporting node contributes to a general "witness-like" pool for this metric
                // This part might need refinement based on how strictly "witness" status should be enforced
            }
        }
    });

    const selfAccount = process.env.STEEM_ACCOUNT;
    let selfIsReportingWitness = false;
    if (selfAccount && witnessSteemAccounts.has(selfAccount)) {
        selfIsReportingWitness = true;
        // Avoid double counting if self is also in networkSyncStatus (e.g. through local peer discovery)
        let selfInNetworkMapAsWitness = false;
        if (p2p.nodeId?.pub && networkSyncStatus.has(p2p.nodeId.pub)) {
            const selfStatus = networkSyncStatus.get(p2p.nodeId.pub)!;
             const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(p2p.nodeId.pub) : null;
            if (peerAccount && witnessSteemAccounts.has(peerAccount) && (now - selfStatus.timestamp < STEEM_HEIGHT_EXPIRY *2) ) {
                 selfInNetworkMapAsWitness = true; // Self is already counted in the loop
            }
        }
        if (!selfInNetworkMapAsWitness) {
            relevantBehindValues.push(behindBlocks); // Add local behindBlocks
            witnessesReportingCount++;
            if (behindBlocks > behindThresholdForWitness) {
                witnessesConsideredBehindCount++;
            }
        }
    }


    if (relevantBehindValues.length === 0) { // No peers reporting, only self matters if it's a witness
        if (selfIsReportingWitness) {
             return { maxBehind: behindBlocks, medianBehind: behindBlocks, numReporting: 1, numWitnessesReporting: 1, witnessesBehindThreshold: behindBlocks > behindThresholdForWitness ? 1 : 0 };
        } // If self is not a witness and no peers, then all zero.
        return { maxBehind: 0, medianBehind: 0, numReporting: 0, numWitnessesReporting: 0, witnessesBehindThreshold: 0 };
    }

    relevantBehindValues.sort((a, b) => a - b);
    const maxBehind = relevantBehindValues[relevantBehindValues.length - 1];
    const mid = Math.floor(relevantBehindValues.length / 2);
    const medianBehind = relevantBehindValues.length % 2 !== 0 ? relevantBehindValues[mid] : (relevantBehindValues[mid - 1] + relevantBehindValues[mid]) / 2;

    return {
        maxBehind,
        medianBehind,
        numReporting: relevantBehindValues.length,
        numWitnessesReporting: witnessesReportingCount,
        witnessesBehindThreshold: witnessesConsideredBehindCount
    };
};

const isNetworkReadyToEnterSyncMode = (localNodeBehindBlocks: number): boolean => {
    const now = Date.now();
    let nodesIndicatingSyncNeeded = 0; // Nodes that are syncing OR significantly behind
    let consideredPeersForEntry = 0;
    const witnessAccounts = new Set(chain.schedule.active_witnesses || (config as any).activeWitnesses || []);
    let witnessPeersIndicatingSync = 0;
    let consideredWitnessPeersForEntry = 0;
    const delayThreshold = (config as any).steemBlockDelay || 10;
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatus.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY * 2) { // Consider status up to 60s old
            consideredPeersForEntry++;
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
            const isWitnessPeer = peerAccount && witnessAccounts.has(peerAccount);

            if (isWitnessPeer) {
                consideredWitnessPeersForEntry++;
            } else if (witnessAccounts.size === 0) { // If no specific witness list, count all as potential for witness quorum base
                consideredWitnessPeersForEntry++;
            }

            if (status.isSyncing || status.behindBlocks > delayThreshold) {
                nodesIndicatingSyncNeeded++;
                if (isWitnessPeer) {
                    witnessPeersIndicatingSync++;
                } else if (witnessAccounts.size === 0) {
                     witnessPeersIndicatingSync++;
                }
            }
        }
    });

    const selfAccount = process.env.STEEM_ACCOUNT || "";
    const selfIsWitness = witnessAccounts.has(selfAccount);
    const localNodeIndicatesSync = localNodeBehindBlocks > delayThreshold || isSyncing; // Consider if self is already syncing

    // Add self to consideration if not already counted via loopback peer
    let selfAlreadyCounted = false;
    if (p2p.nodeId?.pub && networkSyncStatus.has(p2p.nodeId.pub) && (now - (networkSyncStatus.get(p2p.nodeId.pub)?.timestamp || 0) < STEEM_HEIGHT_EXPIRY * 2) ) {
        selfAlreadyCounted = true;
    }

    if (!selfAlreadyCounted) {
        consideredPeersForEntry++;
        if (localNodeIndicatesSync) {
            nodesIndicatingSyncNeeded++;
        }
        if (selfIsWitness || witnessAccounts.size === 0) {
            consideredWitnessPeersForEntry++;
            if (localNodeIndicatesSync) {
                witnessPeersIndicatingSync++;
            }
        }
    }


    if (consideredPeersForEntry === 0) { // No peers, decision is local
        if (localNodeBehindBlocks >= ((config as any).steemBlockDelayCritical || delayThreshold * 2)) { // Critically behind
            logger.warn(`No recent peer sync status, but local node is critically behind (${localNodeBehindBlocks} blocks). Allowing sync mode entry.`);
            return true;
        }
        return false; // Not critically behind and no peers
    }

    let percentageIndicatingSync: number;
    let relevantConsideredNodesForEntry: number;

    const minActiveWitnessesForPriority = Math.max(MIN_WITNESSES_FOR_QUORUM_CONSIDERATION, Math.floor(witnessAccounts.size * 0.1));

    if (witnessAccounts.size > 0 && consideredWitnessPeersForEntry >= minActiveWitnessesForPriority) {
        percentageIndicatingSync = consideredWitnessPeersForEntry > 0 ? (witnessPeersIndicatingSync / consideredWitnessPeersForEntry) * 100 : 0;
        relevantConsideredNodesForEntry = consideredWitnessPeersForEntry;
        logger.info(`Sync Entry Decision (Witness Priority): ${witnessPeersIndicatingSync}/${consideredWitnessPeersForEntry} relevant witnesses indicate sync needed. Quorum: ${SYNC_ENTRY_QUORUM_PERCENT}%`);
    } else {
        percentageIndicatingSync = consideredPeersForEntry > 0 ? (nodesIndicatingSyncNeeded / consideredPeersForEntry) * 100 : 0;
        relevantConsideredNodesForEntry = consideredPeersForEntry;
        logger.info(`Sync Entry Decision (General Peers): ${nodesIndicatingSyncNeeded}/${consideredPeersForEntry} relevant peers indicate sync needed. Quorum: ${SYNC_ENTRY_QUORUM_PERCENT}%`);
    }

    if (percentageIndicatingSync >= SYNC_ENTRY_QUORUM_PERCENT) {
        logger.info(`Network ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`);
        return true;
    }
    logger.info(`Network NOT ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`);
    return false;
};

// steemModule definition
const steemModule = {
    init,
    initSteemSync,
    updateBlockId,
    isInSyncMode,
    processBlock,
    getLatestSteemBlockNum,
    switchToNextEndpoint,
    updateNetworkBehindBlocks, // Kept for now, assess usage
    getBehindBlocks,
    getSyncExitTarget,
    receivePeerSyncStatus,
    getSyncStatus,
    setReadyToReceiveTransactions,
    isOnSteemBlock,
    isProcessingBlock: (blockNum: number) => processingBlocks.includes(blockNum),
    getRpcHeightData: () => rpcHeightData,
    shouldBeLenient, // Added export
    handlePostSyncReady, // Added export
    getLastSyncExitTime, // Added export

    // Functions crucial for new sync logic
    updateLocalSteemState,
    getNetworkOverallBehindBlocks,
    isNetworkReadyToEnterSyncMode,
    shouldExitSyncMode,            // Original, preserved
    enterSyncMode,               // Original, preserved
    exitSyncMode,                // Original, preserved
    isNetworkReadyToExitSyncMode // Original, preserved
};

export default steemModule; 