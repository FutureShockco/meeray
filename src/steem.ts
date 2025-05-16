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
    behindBlocks: number;
    steemBlock: number;
    isSyncing: boolean;
    blockId: number;
    consensusBlocks: any;
    exitTarget: number | null;
    timestamp?: number;
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
const DEFAULT_BROADCAST_INTERVAL = 10000; // 10 seconds
const FAST_BROADCAST_INTERVAL = 5000; // 5 second

// --- Post-sync cooldown and READY handshake ---
const POST_SYNC_LENIENT_BLOCKS = 5; // Number of blocks to be lenient after sync exit
let postSyncLenientUntil: number | null = null; // Block height until which leniency applies
let readySent = false;

// Track when to exit sync mode
let syncExitTargetBlock: number | null = null;  // Target block to exit sync mode
let consecutiveErrors = 0;
let retryDelay = MIN_RETRY_DELAY;
let circuitBreakerOpen = false;

// Cache for prefetched blocks
let blockCache = new Map<number, SteemBlock>();
let prefetchInProgress = false;

// Add at the top of the file with other initialization variables
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
const SYNC_EXIT_QUORUM_PERCENT = 60; // Require 60% of nodes to be caught up before exiting sync mode

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
// if (!isTestnet) {
//     client = new DsteemClient(apiUrls[currentEndpointIndex], {
//         addressPrefix: 'STM',
//         chainId: '0000000000000000000000000000000000000000000000000000000000000000',
//         timeout: 15000  // Increased timeout for better reliability
//     });
// }
// else {
//     logger.info('Using testnet API');
//     client = new DsteemClient('https://testapi.moecki.online', {
//         addressPrefix: 'MTN',
//         chainId: '1aa939649afcc54c67e01a809967f75b8bee5d928aa6bdf237d0d5d6bfbc5c22',
//         timeout: 15000  // Increased timeout for better reliability
//     });
// }

client = new DsteemClient(apiUrls[currentEndpointIndex], {
    addressPrefix: 'STM',
    chainId: '0000000000000000000000000000000000000000000000000000000000000000',
    timeout: 15000  // Increased timeout for better reliability
});

let nextSteemBlock = 0;
// Map to store peer sync statuses
const peerSyncStatuses: Record<string, SyncStatus> = {};

/**
 * Initialize the Steem module
 * @param blockNum - The block number to start syncing from
 */
const init = (blockNum: number): void => {
    nextSteemBlock = blockNum;
    if (syncInterval) clearInterval(syncInterval);
    logger.info('Initializing Steem module for block', nextSteemBlock);
    // Set initial state
    setReadyToReceiveTransactions(false);
    syncExitTargetBlock = null; // Reset sync exit target
    startSyncStatusBroadcasting();
    readySent = false;

    checkNetworkSyncStatus().then(async () => {
        // Wait a bit to collect peer statuses
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get network's view of sync status
        const networkStatus = getNetworkSyncStatus();

        if (!p2p.recovering && networkStatus.referenceExists && networkStatus.referenceNodeId !== 'self') {
            // We have a reference node with higher blocks
            const referenceBlock = networkStatus.highestBlock;
            logger.info(`Found reference node with higher block ${referenceBlock}, prioritizing network sync first`);

            // Start actively requesting blocks from peers
            let lastRequestedBlock = chain?.getLatestBlock()?._id || 0;
            const requestBlocks = async () => {
                const currentBlock = chain?.getLatestBlock()?._id || 0;
                const blocksBehind = referenceBlock - currentBlock;

                if (blocksBehind <= 5) {
                    logger.info('Network sync nearly complete, starting Steem sync');
                    if (waitForNetworkSync) clearInterval(waitForNetworkSync);
                    if (blockRequestInterval) clearInterval(blockRequestInterval);
                    initSteemSync(blockNum);
                    return;
                }

                // Request next batch of blocks if we haven't received previous ones
                if (currentBlock === lastRequestedBlock) {
                    // Request a batch of blocks from peers
                    if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                        const batchSize = Math.min(10, blocksBehind); // Request up to 10 blocks at a time
                        for (let i = 0; i < batchSize; i++) {
                            const blockToRequest = currentBlock + i + 1;
                            p2p.broadcast({
                                t: 2, // QUERY_BLOCK message type
                                d: blockToRequest
                            });
                        }
                        lastRequestedBlock = currentBlock + batchSize;
                        logger.info(`Requested blocks ${currentBlock + 1} to ${lastRequestedBlock} from peers`);
                    }
                }

                logger.info(`Catching up with network, head block: ${currentBlock}, target: ${referenceBlock}, ${blocksBehind} blocks behind`);
            };

            const waitForNetworkSync = setInterval(requestBlocks, 3000);
            const blockRequestInterval = setInterval(requestBlocks, 1000);
            requestBlocks();
        }
    }).catch(err => {
        logger.error('Error checking network sync status:', err);
        initSteemSync(blockNum);
    });
};

/**
 * Switch to the next endpoint when current one fails
 * @returns {boolean} True if successfully switched
 */
const switchToNextEndpoint = (): boolean => {
    if (apiUrls.length <= 1) return false;

    // Find the most up-to-date RPC
    let bestEndpoint = apiUrls[0];
    let highestBlock = 0;

    for (const [url, data] of rpcHeightData.entries()) {
        if (apiUrls.includes(url) && data.height > highestBlock) {
            highestBlock = data.height;
            bestEndpoint = url;
        }
    }

    // If we found a better endpoint, use it
    if (bestEndpoint !== client.address) {
        logger.info(`Switching to better Steem API endpoint: ${bestEndpoint}`);
        client = new DsteemClient(bestEndpoint, {
            addressPrefix: 'STM',
            chainId: '0000000000000000000000000000000000000000000000000000000000000000',
            timeout: 15000  // Increased timeout for better reliability
        });
        return true;
    }

    // Otherwise, use round-robin as fallback
    currentEndpointIndex = (currentEndpointIndex + 1) % apiUrls.length;
    const newEndpoint = apiUrls[currentEndpointIndex];

    logger.info(`Switching to next Steem API endpoint: ${newEndpoint}`);
    client = new DsteemClient(newEndpoint, {
        addressPrefix: 'STM',
        chainId: '0000000000000000000000000000000000000000000000000000000000000000',
        timeout: 15000  // Increased timeout for better reliability
    });
    return true;
};

/**
 * Update the current Steem block ID
 * @param blockNum - The new block number
 */
const updateBlockId = (blockNum: number): void => {
    currentSteemBlock = blockNum;
};

/**
 * Stop broadcasting sync status
 */
function stopSyncStatusBroadcasting(): void {
    if (syncStatusBroadcastInterval) {
        clearInterval(syncStatusBroadcastInterval);
        syncStatusBroadcastInterval = null;
        lastBroadcastInterval = null;
    }
}

/**
 * Start broadcasting sync status
 */
function startSyncStatusBroadcasting(): void {
    stopSyncStatusBroadcasting(); // Always clear any previous interval
    // Add random jitter to avoid synchronization
    const jitter = Math.floor(Math.random() * 2000); // up to 2s
    syncStatusBroadcastInterval = setInterval(broadcastSyncStatusLoop, DEFAULT_BROADCAST_INTERVAL + jitter);
    lastBroadcastInterval = DEFAULT_BROADCAST_INTERVAL;
    // Initial broadcast
    broadcastSyncStatusLoop();
}

/**
 * Broadcast sync status to the network
 */
function broadcastSyncStatusLoop(): void {
    // Always broadcast in sync mode or when behind
    const shouldBroadcast = isSyncing || behindBlocks >= config.steemBlockDelay;
    const interval = shouldBroadcast ? FAST_BROADCAST_INTERVAL : DEFAULT_BROADCAST_INTERVAL;

    if (lastBroadcastInterval !== interval) {
        if (syncStatusBroadcastInterval) clearInterval(syncStatusBroadcastInterval);
        // Add random jitter to avoid synchronization
        const jitter = Math.floor(Math.random() * 2000); // up to 2s
        syncStatusBroadcastInterval = setInterval(broadcastSyncStatusLoop, interval + jitter);
        lastBroadcastInterval = interval;
    }

    if (p2p && p2p.sockets && p2p.sockets.length > 0 && chain.getLatestBlock() && chain.getLatestBlock()._id) {
        // Prepare current status
        const currentStatus: SyncStatus = {
            behindBlocks: behindBlocks,
            steemBlock: currentSteemBlock,
            isSyncing: isSyncing,
            blockId: chain.getLatestBlock()._id,
            consensusBlocks: null,
            exitTarget: syncExitTargetBlock
        };

        // Always broadcast if we're behind or in sync mode
        if (shouldBroadcast) {
            p2p.broadcastSyncStatus(currentStatus);
            lastBroadcastedSyncStatus = { ...currentStatus };
            lastForcedBroadcast = Date.now();
        }
    }
}

/**
 * Enter sync mode
 */
function enterSyncMode(): void {
    isSyncing = true;
    syncExitTargetBlock = null;
    startSyncStatusBroadcasting();
    readySent = false; // Only reset readySent when entering sync mode
}

/**
 * Exit sync mode
 * @param currentBlockId - The current block ID
 */
function exitSyncMode(currentBlockId: number, currentSteemBlockNum: number): void {
    logger.info(`Exiting sync mode at block ${currentBlockId} (Steem block: ${currentSteemBlockNum})`);
    isSyncing = false;

    // Set post-sync lenient period
    postSyncLenientUntil = currentBlockId + POST_SYNC_LENIENT_BLOCKS;
    logger.info(`Setting lenient validation until block ${postSyncLenientUntil}`);

    // Record the time of sync exit for future reference
    lastSyncExitTime = new Date().getTime();

    // Broadcast exit to peers
    if (p2p && p2p.sockets && p2p.sockets.length > 0) {
        const exitStatus: SyncStatus = {
            behindBlocks: behindBlocks,
            steemBlock: currentSteemBlockNum,
            isSyncing: false,
            blockId: currentBlockId,
            consensusBlocks: behindBlocks,
            exitTarget: null
        };
        p2p.broadcastSyncStatus(exitStatus);
    }
}

/**
 * Handle post-sync READY handshake with peers
 * @param blockId - Current block ID
 */
function handlePostSyncReady(blockId: number): void {
    if (!readySent && !isSyncing && postSyncLenientUntil && blockId <= postSyncLenientUntil) {
        // Send READY to peers
        if (p2p && p2p.sockets && p2p.sockets.length > 0) {
            //p2p.broadcast({ t: 12 });
            logger.info(`Sent READY handshake to peers at block ${blockId}`);
        }
        readySent = true;
    }
}

/**
 * Check if we should be lenient with validation due to recent sync exit
 * @param blockId - Current block ID
 * @returns True if we should be lenient
 */
function shouldBeLenient(blockId: number): boolean {
    return !!postSyncLenientUntil && blockId <= postSyncLenientUntil;
}

/**
 * Update the network behind blocks value
 * @param newValue - The new value
 */
const updateNetworkBehindBlocks = (newValue: number): void => {
    behindBlocks = newValue;
};

/**
 * Check if we're in sync mode
 * @returns {boolean} True if in sync mode
 */
const isInSyncMode = (): boolean => {
    return isSyncing;
};

/**
 * Check if we should exit sync mode
 * @param currentBlockId - The current block ID
 * @returns {boolean} True if we should exit sync mode
 */
const shouldExitSyncMode = (currentBlockId: number): boolean => {
    // If we're already out of sync mode, no need to check
    if (!isSyncing) return false;

    // Check if we've reached our exit target
    if (syncExitTargetBlock !== null && currentBlockId >= syncExitTargetBlock) {
        return true;
    }

    // Check if we're close enough to the network
    if (behindBlocks <= SYNC_EXIT_THRESHOLD) {
        return isNetworkReadyToExitSyncMode();
    }

    return false;
};

/**
 * Prefetch Steem blocks
 * @param blockNum - The starting block number
 */
const prefetchBlocks = async (blockNum: number): Promise<void> => {
    if (prefetchInProgress || circuitBreakerOpen) return;
    prefetchInProgress = true;
    let currentBlock = blockNum || config.steemStartBlock;
    const latestSteemBlock = await getLatestSteemBlockNum();
    if (!latestSteemBlock) {
        prefetchInProgress = false;
        logger.warn(`Could not fetch latest steem block`);
        return;
    }
    let blocksToPrefetch = PREFETCH_BLOCKS;
    const localBehindBlocks = latestSteemBlock - currentBlock;
    if (localBehindBlocks > MAX_PREFETCH_BLOCKS) {
        blocksToPrefetch = MAX_PREFETCH_BLOCKS;
        logger.debug(`Very far behind (${localBehindBlocks} blocks) - aggressive prefetching ${blocksToPrefetch} blocks`);
    }
    blocksToPrefetch = Math.min(blocksToPrefetch, latestSteemBlock - currentBlock);
    if (blocksToPrefetch <= 0) {
        prefetchInProgress = false;
        return;
    }
    let missedBlocks = 0;
    let processedFirstBlock = false;
    try {
        for (let i = 0; i < blocksToPrefetch && !circuitBreakerOpen; i++) {
            const blockToFetch = currentBlock + i;
            // Skip blocks already being processed or in cache
            if (processingBlocks.includes(blockToFetch) || blockCache.has(blockToFetch)) {
                continue;
            }
            try {
                const steemBlock = await client.database.getBlock(blockToFetch);
                if (steemBlock) {
                    blockCache.set(blockToFetch, steemBlock as any);
                } else {
                    missedBlocks++;
                    logger.warn(`No data returned for Steem block ${blockToFetch}`);
                    // If this is the first block and we couldn't get it, try to move past it
                    if (i === 0 && !processedFirstBlock) {
                        if (consecutiveErrors > 3) {
                            logger.warn(`Skipping problematic block ${blockToFetch} after multiple failures`);
                            nextSteemBlock = blockToFetch + 1;
                            resetConsecutiveErrors();
                        } else {
                            incrementConsecutiveErrors();
                        }
                    }
                }
            } catch (error) {
                missedBlocks++;
                incrementConsecutiveErrors();
                logger.warn(`Failed to prefetch Steem block ${blockToFetch}:`, error);
                // If this is the first block and we've been stuck for a while, try to move past it
                if (i === 0 && !processedFirstBlock && consecutiveErrors > 5) {
                    logger.warn(`Moving past problematic block ${blockToFetch} after ${consecutiveErrors} consecutive errors`);
                    nextSteemBlock = blockToFetch + 1;
                    resetConsecutiveErrors();
                }
            }
            // Throttle requests in sync mode
            if (isSyncing) {
                await new Promise(resolve => setTimeout(resolve, SYNC_BLOCK_FETCH_DELAY));
            }
        }
        // If we've missed too many blocks, try switching endpoints
        if (missedBlocks > blocksToPrefetch / 2) {
            logger.warn(`Missed ${missedBlocks}/${blocksToPrefetch} blocks, switching RPC endpoint`);
            switchToNextEndpoint();
        }
        // Trim cache if it gets too large
        if (blockCache.size > blocksToPrefetch * 2) {
            const keysArray = Array.from(blockCache.keys()).sort((a, b) => a - b);
            const keysToDelete = keysArray.slice(0, blockCache.size - blocksToPrefetch);
            keysToDelete.forEach(key => blockCache.delete(key));
        }
    } finally {
        prefetchInProgress = false;
    }
};

/**
 * Process a Steem block
 * @param blockNum - The block number to process
 * @returns {Promise<SteemBlock | null>} The processed block
 */
const processBlock = async (blockNum: number): Promise<SteemBlockResult | null> => {
    if (p2p.recovering) {
        logger.debug('Skipping Steem block processing - node not ready to receive transactions yet');
        return Promise.resolve(null);
    }
    currentSteemBlock = chain.getLatestBlock()?.steemBlockNum;
    // Check if we're trying to process a block out of order
    if (blockNum !== currentSteemBlock + 1) {
        logger.warn(`Attempting to process block ${blockNum} before ${currentSteemBlock + 1}, skipping`);
        return Promise.resolve(null);
    }

    if (processingBlocks.includes(blockNum)) {
        logger.debug(`Block ${blockNum} is already being processed`);
        return Promise.resolve(null);
    }

    // Add the block to the processing list
    processingBlocks.push(blockNum);

    try {
        // Check if block is in cache
        let steemBlock = blockCache.get(blockNum);
        if (!steemBlock) {
            try {
                const rawSteemBlock = await client.database.getBlock(blockNum);
                if (rawSteemBlock) {
                    // Convert to our format and cache the block
                    steemBlock = {
                        transactions: rawSteemBlock.transactions || [],
                        timestamp: rawSteemBlock.timestamp
                    };
                    blockCache.set(blockNum, steemBlock);
                    // Limit cache size
                    if (blockCache.size > PREFETCH_BLOCKS * 10) {
                        // Delete oldest entries (approximate LRU)
                        const keysToDelete = Array.from(blockCache.keys()).slice(0, PREFETCH_BLOCKS);
                        keysToDelete.forEach(key => blockCache.delete(key));
                    }
                }
            } catch (error) {
                incrementConsecutiveErrors();
                logger.error(`Failed to fetch Steem block ${blockNum}:`, error);
                // Remove from processing list
                processingBlocks = processingBlocks.filter(b => b !== blockNum);
                return Promise.reject(error);
            }
        }
        if (!steemBlock) {
            logger.warn(`Steem block ${blockNum} not found`);
            // Remove from processing list
            processingBlocks = processingBlocks.filter(b => b !== blockNum);
            return Promise.resolve(null);
        }
        const steemBlockResult = await parseSteemTransactions(steemBlock, blockNum);
        // Update currentSteemBlock after successful processing
        currentSteemBlock = Math.max(currentSteemBlock, blockNum);
        resetConsecutiveErrors();
        // Add transactions to the pool
        if (steemBlockResult.transactions.length > 0) {
 
            transaction.addToPool(steemBlockResult.transactions);
        }
        // Remove from processing list
        processingBlocks = processingBlocks.filter(b => b !== blockNum);
        return Promise.resolve(steemBlockResult);
    } catch (error) {
        incrementConsecutiveErrors();
        logger.error(`Error processing Steem block ${blockNum}:`, error);
        // Remove from processing list
        processingBlocks = processingBlocks.filter(b => b !== blockNum);
        return Promise.reject(error);
    }
};

/**
 * Get the network sync status
 * @returns {NetworkSyncStatus} The network sync status
 */
const getNetworkSyncStatus = (): NetworkSyncStatus => {
    // Implementation will go here
    // This function is a placeholder for the full implementation
    return {
        highestBlock: 0,
        referenceExists: false,
        referenceNodeId: 'self'
    };
};

/**
 * Get the median of a list of numbers
 * @param numbers - The numbers to get the median of
 * @returns {number} The median
 */
const getMedian = (numbers: number[]): number => {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
};

/**
 * Get the valid RPC heights
 * @returns {Map<string, number>} The valid RPC heights
 */
const getValidRpcHeights = (): Map<string, number> => {
    const now = Date.now();
    const validHeights = new Map<string, number>();

    for (const [url, data] of rpcHeightData.entries()) {
        // Filter out old data
        if (now - data.timestamp < 60000) { // 1 minute expiry
            validHeights.set(url, data.height);
        }
    }

    return validHeights;
};

/**
 * Calculate retry delay with exponential backoff
 * @returns {number} The calculated delay
 */
const calculateRetryDelay = (): number => {
    return Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
};

/**
 * Increment consecutive errors counter
 */
const incrementConsecutiveErrors = (): void => {
    consecutiveErrors++;
    retryDelay = calculateRetryDelay();

    if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD && !circuitBreakerOpen) {
        circuitBreakerOpen = true;
        logger.error(`Circuit breaker opened after ${consecutiveErrors} consecutive errors`);
        // Perform emergency actions
        enterSyncMode();
    }
};

/**
 * Reset consecutive errors counter
 */
const resetConsecutiveErrors = (): void => {
    consecutiveErrors = 0;
    retryDelay = MIN_RETRY_DELAY;
    circuitBreakerOpen = false;
    logger.debug('Reset consecutive errors counter');
};

/**
 * Fetch a missing Steem block
 * @param blockNum - The block number to fetch
 * @returns {Promise<SteemBlock | null>} The fetched block
 */
const fetchMissingBlock = async (blockNum: number): Promise<SteemBlock | null> => {
    // Function to fetch a specific Steem block that's missing from cache
    logger.info('Fetching missing Steem block:', blockNum)
    prefetchInProgress = true

    try {
        let retries = 5 // Increase retries from 3 to 5
        let rawSteemBlock = null

        while (retries > 0) {
            try {
                // Try the current endpoint
                rawSteemBlock = await client.database.getBlock(blockNum)
                if (rawSteemBlock) break
            } catch (err) {
                logger.warn(`Error fetching block ${blockNum} (${retries} retries left): ${err}`)

                if (retries === 3) {
                    // Switch endpoints after a couple of failures
                    switchToNextEndpoint()
                    logger.info(`Switched RPC endpoint while fetching block ${blockNum}`)
                }

                retries--
                if (retries === 0) throw err
                await new Promise(resolve => setTimeout(resolve, 2000)) // Increase retry delay to 2 seconds
            }
        }

        if (rawSteemBlock) {
            const steemBlock: SteemBlock = {
                transactions: rawSteemBlock.transactions || [],
                timestamp: rawSteemBlock.timestamp
            };

            // Cache the block for future reference
            blockCache.set(blockNum, steemBlock)
            logger.debug('Successfully fetched and cached missing block:', blockNum)

            prefetchInProgress = false
            return steemBlock
        } else {
            logger.error('Failed to fetch missing block after retries:', blockNum)
            prefetchInProgress = false
            return null
        }
    } catch (err) {
        prefetchInProgress = false
        logger.error('Error fetching missing block:', blockNum, err)
        return null
    }
};

/**
 * Get the latest Steem block number
 * @returns {Promise<number>} The latest block number
 */
// Function to get the latest Steem block number
const getLatestSteemBlockNum = async () => {
    try {
        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        if (dynGlobalProps && dynGlobalProps.head_block_number) {
            return dynGlobalProps.head_block_number
        } else {
            throw new Error('Invalid response from getDynamicGlobalProperties')
        }
    } catch (error) {
        logger.warn('Error getting latest Steem block number:', error)

        // Try switching endpoints and try again
        if (switchToNextEndpoint()) {
            try {
                logger.info('Trying alternate endpoint for getLatestSteemBlockNum')
                const dynGlobalProps = await client.database.getDynamicGlobalProperties()
                if (dynGlobalProps && dynGlobalProps.head_block_number) {
                    return dynGlobalProps.head_block_number
                }
            } catch (retryError) {
                logger.error('Error with alternate endpoint for getLatestSteemBlockNum:', retryError)
            }
        }

        // If we have cached RPC heights, use the highest one
        if (rpcHeightData.size > 0) {
            const validHeights = Array.from(rpcHeightData.values()).map(data => data.height);
            const highestBlockHeight = Math.max(...validHeights);
            if (highestBlockHeight > 0) {
                logger.info(`Using cached highest RPC block height: ${highestBlockHeight}`);
                return highestBlockHeight;
            }
        }

        return null
    }
}

/**
 * Check the network sync status
 * @returns {Promise<void>}
 */
const checkNetworkSyncStatus = async (): Promise<void> => {
    // Implementation will go here
    // This function is a placeholder for the full implementation
};

/**
 * Receive peer sync status
 * @param nodeId - The node ID
 * @param status - The sync status
 */
const receivePeerSyncStatus = (nodeId: string, status: SyncStatus): void => {
    // Update our tracking of peer sync status
    peerSyncStatuses[nodeId] = status;

    // Update our network's view of Steem block height
    if (status.steemBlock && status.steemBlock > 0) {
        networkSteemHeights.set(nodeId, {
            steemBlock: status.steemBlock,
            behindBlocks: status.behindBlocks,
            timestamp: Date.now(),
            blockId: status.blockId,
            consensusBlocks: status.consensusBlocks,
            isInWarmup: status.isSyncing,
            exitTarget: status.exitTarget
        });
    }

    // Check if we're in sync mode and most peers aren't, consider exiting
    const currentTime = Date.now();

    // Clean up old statuses
    for (const id in peerSyncStatuses) {
        // Keep entries for up to 2 minutes
        if (currentTime - (peerSyncStatuses[id].timestamp || 0) > 120000) {
            delete peerSyncStatuses[id];
        }
    }

    // Log when a significant node reports sync status
    if (nodeId === 'master') {
        logger.debug(`Master node sync status: ${JSON.stringify(status)}`);
    }

    // If we're in sync mode but network says we can exit
    if (isSyncing && isNetworkReadyToExitSyncMode()) {
        const currentBlockId = chain?.getLatestBlock()?._id || 0;

        if (!syncExitTargetBlock || currentBlockId >= syncExitTargetBlock) {
            // Set a nearby exit target if one isn't already set
            syncExitTargetBlock = currentBlockId + 5;
            logger.info(`Network consensus indicates we can exit sync mode soon at block ${syncExitTargetBlock}`);
        }
    }
};

/**
 * Get the current sync status
 * @returns {object} The current sync status
 */
const getSyncStatus = (): { isSyncing: boolean; behindBlocks: number } => {
    return {
        isSyncing,
        behindBlocks
    };
};

/**
 * Check if the network is ready to exit sync mode
 * @returns {boolean} True if the network is ready
 */
const isNetworkReadyToExitSyncMode = (): boolean => {
    const networkStatus = getNetworkSyncStatus();

    // If we're not the reference node, we ONLY exit when the reference node exits
    if (networkStatus.referenceExists && networkStatus.referenceNodeId !== 'self') {
        // Find reference node's sync status
        const referenceStatus = networkSteemHeights.get(networkStatus.referenceNodeId);
        if (referenceStatus) {
            // Only exit if reference node is not in sync mode
            if (referenceStatus.isInWarmup) {
                logger.debug(`Staying in sync mode - reference node ${networkStatus.referenceNodeId} is still warming up`);
                return false;
            }
            // Exit only if reference node has exited recently (within last 60 seconds)
            const timeSinceReferenceExit = Date.now() - (referenceStatus.timestamp || 0);
            if (timeSinceReferenceExit > 60000) {
                logger.debug(`Reference node sync status too old (${timeSinceReferenceExit}ms), staying in sync mode`);
                return false;
            }

            // Make sure we're at the same block as reference node or very close
            const currentBlock = chain?.getLatestBlock()?._id || 0;
            if (referenceStatus.blockId && Math.abs(currentBlock - referenceStatus.blockId) > 3) {
                logger.debug(`We are at block ${currentBlock} but reference node exited at block ${referenceStatus.blockId}, staying in sync`);
                return false;
            }

            logger.debug(`Following reference node ${networkStatus.referenceNodeId} to exit sync mode at block ${currentBlock}`);
            return true;
        }
        logger.debug('Reference node status not found, staying in sync mode');
        return false;
    }

    // If we're the reference node (or no reference exists), we make the decision
    if (behindBlocks > 0) {
        logger.debug('As reference node, staying in sync mode with behindBlocks > 0');
        return false;
    }

    // Count how many nodes are caught up
    let syncedCount = 1; // Include ourselves
    let totalNodes = networkSteemHeights.size + 1;
    let maxBehind = 0;

    // Check other nodes
    for (const [nodeId, status] of networkSteemHeights.entries()) {
        // Check if node is caught up with our current Steem block
        if (Math.abs(status.steemBlock - currentSteemBlock) <= 1) {
            syncedCount++;
        }

        // Track the maximum behind blocks
        maxBehind = Math.max(maxBehind, status.behindBlocks);
    }

    const syncedPercent = (syncedCount / totalNodes) * 100;
    const currentBlock = chain?.getLatestBlock()?._id || 0;

    logger.debug(`Reference node sync status check:
        - Nodes synced: ${syncedCount}/${totalNodes} (${syncedPercent.toFixed(1)}%)
        - Max behind: ${maxBehind}
        - Current block: ${currentSteemBlock}
        - Block ID: ${currentBlock}`);

    // As reference node, require stricter conditions
    const readyToExit = syncedPercent >= SYNC_EXIT_QUORUM_PERCENT &&
        maxBehind <= 1 && // Stricter: ensure nodes are fully caught up
        behindBlocks === 0;

    if (readyToExit) {
        logger.info(`As reference node, signaling network to exit sync mode at block ${currentBlock}`);
    }

    return readyToExit;
};

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
    getLatestSteemBlockNum().then(latestBlock => {
        if (latestBlock) {
            // Get the Steem block from our last chain block
            let lastProcessedSteemBlock = 0;
            if (chain && chain.getLatestBlock() && chain.getLatestBlock().steemBlock) {
                lastProcessedSteemBlock = chain.getLatestBlock().steemBlock;
            } else if (config.steemStartBlock) {
                lastProcessedSteemBlock = config.steemStartBlock;
            } else {
                lastProcessedSteemBlock = blockNum;
            }

            // Calculate how many blocks we're behind
            behindBlocks = Math.max(0, latestBlock - lastProcessedSteemBlock);
            logger.info(`Initialized Steem Sync - ${behindBlocks} behind (Steem: ${latestBlock}, Sidechain: ${lastProcessedSteemBlock})`);

            // Start prefetching blocks
            if (behindBlocks > 0) {
                prefetchBlocks(lastProcessedSteemBlock + 1);
            }
        }
    }).catch(err => {
        logger.error('Error initializing behind blocks count:', err);
    });

};

/**
 * Check if a block's transactions exist on Steem
 * @param block - The block to check
 * @returns {Promise<boolean>} True if on Steem
 */
const isOnSteemBlock = async (block: Block): Promise<boolean> => {
    try {
        // Try to get the block from cache
        logger.debug(`Validating transactions in block ${block._id} against Steem block ${block.steemBlockNum}`);
        let steemBlock = blockCache.get(block.steemBlockNum);

        // If block not in cache, try to fetch it
        if (!steemBlock) {
            logger.warn(`Steem block ${block.steemBlockNum} not found in cache, attempting to fetch it`);
            // @ts-ignore
            steemBlock = await fetchMissingBlock(block.steemBlockNum);

            // If still can't get the block, resolve with false
            if (!steemBlock) {
                logger.error(`Could not fetch Steem block ${block.steemBlockNum} after attempts`);
                return false;
            }
            logger.debug(`Successfully fetched Steem block ${block.steemBlockNum} with ${steemBlock.transactions.length} transactions`);
        }

        // If we have no transactions to validate, return true
        if (!block.txs || block.txs.length === 0) {
            logger.debug(`Block ${block._id} has no transactions, skipping Steem validation`);
            return true;
        }

        logger.debug(`Validating ${block.txs.length} transactions against Steem block ${block.steemBlockNum}`);

        // Check each transaction in our block against Steem block
        for (let i = 0; i < block.txs.length; i++) {
            const tx = block.txs[i];
            if (typeof tx.type !== 'string' || tx.type !== 'custom_json') {
                logger.debug(`Block ${block._id}, tx #${i}: Not a custom_json operation, skipping`);
                continue;
            }

            // Find matching custom_json operation in Steem block
            let found = false;
            for (let steemTx of steemBlock.transactions) {
                try {
                    for (let op of steemTx.operations) {
                        // Safely type check operations
                        if (!Array.isArray(op) || op.length < 2 || typeof op[0] !== 'string') {
                            continue;
                        }

                        const opType = op[0];
                        const opData = op[1];

                        if (opType !== 'custom_json') {
                            continue;
                        }

                        // Make sure it's a proper custom_json operation
                        if (!opData || typeof opData !== 'object' || !opData.id || !opData.json) {
                            continue;
                        }

                        try {
                            if (opData.id === 'sidechain') {
                                const jsonData = JSON.parse(opData.json);
                                if (jsonData &&
                                    jsonData.contract === (tx.data?.contract || '') &&
                                    JSON.stringify(jsonData.payload) === JSON.stringify(tx.data?.payload || {})) {
                                    found = true;
                                    logger.debug(`Block ${block._id}, tx #${i}: Found matching transaction in Steem block`);
                                    break;
                                }
                            }
                        } catch (parseErr) {
                            logger.error(`Error parsing JSON in Steem operation:`, parseErr);
                        }
                    }
                    if (found) break;
                } catch (txErr) {
                    logger.error(`Error processing transaction in Steem block:`, txErr);
                }
            }

            if (!found) {
                logger.error(`Block ${block._id}, tx #${i}: Transaction not found in Steem block ${block.steemBlockNum}`);
                return false;
            }
        }

        // All transactions were found in the Steem block
        logger.info(`Block ${block._id}: All ${block.txs.length} transactions validated against Steem block ${block.steemBlockNum}`);
        return true;
    } catch (error) {
        logger.error(`Error validating block ${block._id} against Steem:`, error);
        return false;
    }
};

/**
 * Get the number of blocks behind
 * @returns {number} The number of blocks behind
 */
const getBehindBlocks = (): number => {
    return behindBlocks;
};

/**
 * Get the sync exit target block
 * @returns {number | null} The sync exit target block
 */
const getSyncExitTarget = (): number | null => {
    return syncExitTargetBlock;
};



// Export all functions that should be available to other modules
export {
    init,
    initSteemSync,
    updateBlockId,
    isInSyncMode,
    processBlock,
    isOnSteemBlock,
    getSyncStatus,
    receivePeerSyncStatus,
    getNetworkSyncStatus,
    prefetchBlocks,
    getBehindBlocks,
    getSyncExitTarget,
    updateNetworkBehindBlocks,
    stopSyncStatusBroadcasting,
    startSyncStatusBroadcasting,
    switchToNextEndpoint,
    resetConsecutiveErrors,
    setReadyToReceiveTransactions,
    exitSyncMode,
    handlePostSyncReady,
    shouldBeLenient,
    getLatestSteemBlockNum,
    shouldExitSyncMode
};

// Set the steem module in globals
const steemExports = {
    init,
    initSteemSync,
    updateBlockId,
    isInSyncMode,
    processBlock,
    isOnSteemBlock,
    getSyncStatus,
    receivePeerSyncStatus,
    getNetworkSyncStatus,
    prefetchBlocks,
    getBehindBlocks,
    getSyncExitTarget,
    updateNetworkBehindBlocks,
    stopSyncStatusBroadcasting,
    startSyncStatusBroadcasting,
    switchToNextEndpoint,
    resetConsecutiveErrors,
    setReadyToReceiveTransactions,
    exitSyncMode,
    lastSyncExitTime,
    handlePostSyncReady,
    shouldBeLenient,
    getLatestSteemBlockNum,
    shouldExitSyncMode
};

export default steemExports; 