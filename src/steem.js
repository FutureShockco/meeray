const dsteem = require('dsteem')
// Setup multiple endpoints with manual failover
const apiUrls = process.env.STEEM_API ? process.env.STEEM_API.split(',').map(url => url.trim()) : ['https://api.steemit.com']
console.log('Using Steem API URLs:', apiUrls)

// Track current endpoint and create initial client
let currentEndpointIndex = 0
let client = new dsteem.Client(apiUrls[currentEndpointIndex], {
    failoverThreshold: 3,
    addressPrefix: 'STM',
    chainId: '0000000000000000000000000000000000000000000000000000000000000000'
})

// Create a function to switch to the next endpoint when current one fails
const switchToNextEndpoint = () => {
    if (apiUrls.length <= 1) return false

    // Find the most up-to-date RPC
    let bestEndpoint = apiUrls[0]
    let highestBlock = 0

    for (const [url, height] of rpcBlockHeights.entries()) {
        if (apiUrls.includes(url) && height > highestBlock) {
            highestBlock = height
            bestEndpoint = url
        }
    }

    // If we found a better endpoint, use it
    if (bestEndpoint !== client.address) {
        logr.info(`Switching to better Steem API endpoint: ${bestEndpoint}`)
        client = new dsteem.Client(bestEndpoint, {
            failoverThreshold: 3,
            addressPrefix: 'STM',
            chainId: '0000000000000000000000000000000000000000000000000000000000000000'
        })
        return true
    }

    // Otherwise, use round-robin as fallback
    currentEndpointIndex = (currentEndpointIndex + 1) % apiUrls.length
    const newEndpoint = apiUrls[currentEndpointIndex]
    
    logr.info(`Switching to next Steem API endpoint: ${newEndpoint}`)
    client = new dsteem.Client(newEndpoint, {
        failoverThreshold: 3,
        addressPrefix: 'STM',
        chainId: '0000000000000000000000000000000000000000000000000000000000000000'
    })
    return true
}

const transaction = require('./transaction.js')
const Transaction = require('./transactions')

let nextSteemBlock = config.steemStartBlock || 0
let currentSteemBlock = 0
let processingBlocks = []
let isSyncing = false
let forceSyncUntilBlock = 0  // Force sync mode until this block height
let syncInterval = null
let behindBlocks = 0
const MAX_CONSECUTIVE_ERRORS = 20
const MIN_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 15000
const CIRCUIT_BREAKER_THRESHOLD = 30
const CIRCUIT_BREAKER_RESET_TIMEOUT = 30000
const MAX_PREFETCH_BLOCKS = 10  // Maximum number of blocks to prefetch at once
const SYNC_THRESHOLD = 5  // Number of blocks behind before entering sync mode
const SYNC_EXIT_COOLDOWN = 30000 // Increase to 30 seconds cooldown before exiting sync mode
const SYNC_EXIT_BLOCKS_THRESHOLD = 0 // Must be completely caught up to exit sync mode

let consecutiveErrors = 0
let retryDelay = MIN_RETRY_DELAY
let circuitBreakerOpen = false
let lastCircuitBreakerTrip = 0
let healthCheckFailures = 0

// Cache for prefetched blocks
let blockCache = new Map()
let prefetchInProgress = false
let prefetchTimer = null

// Add at the top of the file with other initialization variables
let readyToReceiveTransactions = false

// Add at the top with other constants
let lastSyncModeChange = 0

// Add tracking for sync mode exit time
let lastSyncExitTime = null

// Add new tracking variables at the top with other initialization variables
let rpcBlockHeights = new Map() // Track block heights for each RPC
const RPC_MAX_BLOCK_DIFF = 5 // Maximum allowed difference between RPCs
let lastRpcCheck = 0
const RPC_CHECK_INTERVAL = 10000 // Check RPC sync every 10 seconds

// Add new variables for network consensus based sync mode
let networkSyncStatus = new Map() // Track other nodes' sync status
let lastNetworkSyncCheck = 0
const NETWORK_SYNC_CHECK_INTERVAL = 15000 // Check network sync status every 15 seconds
const SYNC_EXIT_QUORUM_PERCENT = 60 // Require 60% of nodes to be caught up before exiting sync mode
const SYNC_EXIT_THRESHOLD = 3 // Maximum blocks behind to be considered "caught up"

// Helper function to check sync status
const isInSyncMode = () => {
    // Check if we're forced into sync mode by a recent block
    if (chain && chain.getLatestBlock() && chain.getLatestBlock()._id < forceSyncUntilBlock) {
        return true
    }
    return isSyncing
}

// Add a function to set readiness state
const setReadyToReceiveTransactions = (ready) => {
    if (ready !== readyToReceiveTransactions)
        logr.info('Steem transaction processing ' + (ready ? 'ENABLED' : 'DISABLED'))
    readyToReceiveTransactions = ready
}

const prefetchBlocks = async () => {
    if (prefetchInProgress || circuitBreakerOpen) return

    prefetchInProgress = true
    const currentBlock = nextSteemBlock
    const latestSteemBlock = await getLatestSteemBlockNum()

    if (!latestSteemBlock) {
        prefetchInProgress = false
        return
    }

    // Determine how many blocks to prefetch based on sync status
    let blocksToPrefetch = MAX_PREFETCH_BLOCKS
    if (isInSyncMode()) {
        // More aggressive prefetching during sync mode
        blocksToPrefetch = MAX_PREFETCH_BLOCKS * 3
    }

    // Additional prefetching when we're very far behind
    const localBehindBlocks = latestSteemBlock - currentBlock
    if (localBehindBlocks > SYNC_THRESHOLD * 5) {
        blocksToPrefetch = MAX_PREFETCH_BLOCKS * 5
        logr.debug(`Very far behind (${localBehindBlocks} blocks) - aggressive prefetching ${blocksToPrefetch} blocks`)
    }

    // Limit prefetch to the number of blocks we're behind
    blocksToPrefetch = Math.min(blocksToPrefetch, latestSteemBlock - currentBlock)

    if (blocksToPrefetch <= 0) {
        prefetchInProgress = false
        return
    }

    try {
        for (let i = 0; i < blocksToPrefetch && !circuitBreakerOpen; i++) {
            const blockToFetch = currentBlock + i
            if (processingBlocks.includes(blockToFetch) || blockCache.has(blockToFetch)) {
                continue // Skip blocks already being processed or in cache
            }

            try {
                const steemBlock = await client.database.getBlock(blockToFetch)
                if (steemBlock) {
                    blockCache.set(blockToFetch, steemBlock)
                    logr.debug(`Prefetched block ${blockToFetch}`)

                    // Process this block immediately since we have it
                    if (i === 0) {
                        await processBlock(blockToFetch)
                        nextSteemBlock = blockToFetch + 1
                    }
                }
            } catch (error) {
                incrementConsecutiveErrors()
                logr.warn(`Failed to prefetch Steem block ${blockToFetch}:`, error)
                if (i === 0) {
                    // For the next block, we'll retry later
                    break
                }
            }
        }

        // Trim cache if it gets too large
        if (blockCache.size > blocksToPrefetch * 2) {
            const keysArray = Array.from(blockCache.keys()).sort((a, b) => a - b)
            const keysToDelete = keysArray.slice(0, blockCache.size - blocksToPrefetch)
            keysToDelete.forEach(key => blockCache.delete(key))
        }
    } finally {
        prefetchInProgress = false

        // Schedule next prefetch more aggressively if we're far behind
        if (prefetchTimer) clearTimeout(prefetchTimer)

        const prefetchDelay = isInSyncMode() ? 100 : 1000 // Much faster prefetch during sync
        prefetchTimer = setTimeout(prefetchBlocks, prefetchDelay)
    }
}

// Function declarations
const processBlock = async (blockNum) => {
    if (!readyToReceiveTransactions && !isInSyncMode()) {
        logr.debug('Skipping Steem block processing - node not ready to receive transactions yet')
        return Promise.resolve()
    }

    if (processingBlocks.includes(blockNum)) {
        logr.debug(`Block ${blockNum} is already being processed`)
        return Promise.resolve()
    }

    // Add the block to the processing list
    processingBlocks.push(blockNum)

    try {
        // Check if block is in cache
        let steemBlock = blockCache.get(blockNum)
        if (!steemBlock) {
            try {
                steemBlock = await client.database.getBlock(blockNum)
                // Cache the block
                blockCache.set(blockNum, steemBlock)
                // Limit cache size
                if (blockCache.size > MAX_PREFETCH_BLOCKS * 2) {
                    // Delete oldest entries (approximate LRU)
                    const keysToDelete = Array.from(blockCache.keys()).slice(0, MAX_PREFETCH_BLOCKS)
                    keysToDelete.forEach(key => blockCache.delete(key))
                }
            } catch (error) {
                incrementConsecutiveErrors()
                logr.error(`Failed to fetch Steem block ${blockNum}:`, error)
                // Remove from processing list
                processingBlocks = processingBlocks.filter(b => b !== blockNum)
                return Promise.reject(error)
            }
        }

        if (!steemBlock) {
            logr.warn(`Steem block ${blockNum} not found`)
            // Remove from processing list
            processingBlocks = processingBlocks.filter(b => b !== blockNum)
            return Promise.resolve()
        }

        // Process the transactions
        const transactions = await processTransactions(steemBlock, blockNum)

        // Update currentSteemBlock
        currentSteemBlock = Math.max(currentSteemBlock, blockNum)

        // Update behindBlocks after each successful block processing in sync mode
        if (isInSyncMode()) {
            getLatestSteemBlockNum().then(latestBlock => {
                if (latestBlock) {
                    behindBlocks = Math.max(0, latestBlock - blockNum)
                    logr.debug(`Updated blocks behind: ${behindBlocks} after processing Steem block ${blockNum}`)
                }
            }).catch(err => {
                logr.trace('Error updating behind blocks after processing:', err)
            })
        }

        // Reset consecutive errors on success
        resetConsecutiveErrors()

        // Add transactions to the pool
        if (transactions.length > 0) {
            transaction.addToPool(transactions)
        }

        // Remove from processing list
        processingBlocks = processingBlocks.filter(b => b !== blockNum)
        return Promise.resolve(transactions)
    } catch (error) {
        incrementConsecutiveErrors()
        logr.error(`Error processing Steem block ${blockNum}:`, error)
        // Remove from processing list
        processingBlocks = processingBlocks.filter(b => b !== blockNum)
        return Promise.reject(error)
    }
}

// Helper function to process transactions from a Steem block
const processTransactions = async (steemBlock, blockNum) => {
    const txs = []
    const validationPromises = []
    let opIndex = 0

    // Process each transaction
    for (let tx of steemBlock.transactions) {
        for (let op of tx.operations) {
            try {
                const [opType, opData] = op

                if (opType !== 'custom_json' || opData.id !== 'sidechain') {
                    opIndex++
                    continue
                }

                let json
                try {
                    json = JSON.parse(opData.json)
                } catch (e) {
                    logr.warn(`Failed to parse JSON in block ${blockNum}, operation ${opIndex}:`, e)
                    opIndex++
                    continue
                }

                if (!json.contract || !json.contractPayload) {
                    opIndex++
                    continue
                }

                let txType
                switch (json.contract.toLowerCase()) {
                    case 'enablenode':
                        txType = Transaction.Types.ENABLE_NODE
                        break
                    case 'approvenode':
                        txType = Transaction.Types.APPROVE_NODE
                        break
                    case 'createtoken':
                        txType = Transaction.Types.CREATE_TOKEN
                        break
                    case 'minttoken':
                        txType = Transaction.Types.MINT_TOKEN
                        break
                    case 'transfertoken':
                        txType = Transaction.Types.TRANSFER_TOKEN
                        break
                    case 'createnftcollection':
                        txType = Transaction.Types.CREATE_NFT_COLLECTION
                        break
                    case 'mintnft':
                        txType = Transaction.Types.MINT_NFT
                        break
                    case 'transfernft':
                        txType = Transaction.Types.TRANSFER_NFT
                        break
                    case 'createmarket':
                        txType = Transaction.Types.CREATE_MARKET
                        break
                    case 'placeorder':
                        txType = Transaction.Types.PLACE_ORDER
                        break
                    case 'createstakingpool':
                        txType = Transaction.Types.CREATE_STAKING_POOL
                        break
                    case 'staketokens':
                        txType = Transaction.Types.STAKE_TOKENS
                        break
                    case 'unstaketokens':
                        txType = Transaction.Types.UNSTAKE_TOKENS
                        break
                    default:
                        const typeNum = parseInt(json.contract)
                        if (!isNaN(typeNum) && Transaction.transactions[typeNum]) {
                            txType = typeNum
                        } else {
                            logr.debug(`Unknown transaction type in block ${blockNum}, operation ${opIndex}:`, json.contract)
                            opIndex++
                            continue
                        }
                }

                const newTx = {
                    type: txType,
                    data: {
                        contract: json.contract,
                        payload: json.contractPayload
                    },
                    sender: opData.required_posting_auths[0] || opData.required_auths[0],
                    ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                    ref: blockNum + ':' + opIndex
                }

                // Validate the transaction
                validationPromises.push(
                    new Promise((resolve) => {
                        transaction.isValid(newTx, newTx.ts, (isValid, error) => {
                            if (isValid) {
                                txs.push(newTx)
                            } else {
                                logr.debug(`Invalid transaction in block ${blockNum}, operation ${opIndex}:`, error)
                            }
                            resolve()
                        })
                    })
                )

                opIndex++
            } catch (error) {
                logr.error(`Error processing operation ${opIndex} in block ${blockNum}:`, error)
                opIndex++
            }
        }
    }

    // Wait for all validations to complete
    await Promise.all(validationPromises)
    return txs
}

// Function to update our Steem block state and determine sync mode
const updateSteemBlock = async () => {
    try {
        // Check RPC synchronization first
        await checkRpcSync()
        
        // Check network sync status periodically
        const now = Date.now()
        if (now - lastNetworkSyncCheck > NETWORK_SYNC_CHECK_INTERVAL) {
            await checkNetworkSyncStatus()
            lastNetworkSyncCheck = now
        }
        
        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        const latestSteemBlock = dynGlobalProps.head_block_number

        // Get the Steem block from our last chain block
        let lastProcessedSteemBlock = 0
        if (chain && chain.getLatestBlock() && chain.getLatestBlock().steemblock) {
            lastProcessedSteemBlock = chain.getLatestBlock().steemblock
        } else if (config.steemStartBlock) {
            lastProcessedSteemBlock = config.steemStartBlock
        }

        // Update currentSteemBlock
        currentSteemBlock = Math.max(currentSteemBlock, lastProcessedSteemBlock)

        // Calculate blocks behind using the Steem block from our last chain block
        const localBehindBlocks = latestSteemBlock - lastProcessedSteemBlock

        // Sanity check for extreme values
        const MAX_REASONABLE_BEHIND = 20000
        const calculatedBehind = Math.min(localBehindBlocks, MAX_REASONABLE_BEHIND)

        // Update behindBlocks more conservatively
        if (calculatedBehind > behindBlocks || calculatedBehind > SYNC_THRESHOLD) {
            behindBlocks = calculatedBehind
            logr.debug(`Updated blocks behind: ${behindBlocks}`)
            
            // Update our sync status in shared state if we have a p2p connection
            if (p2p && p2p.isNodeConnected()) {
                p2p.broadcastSyncStatus(behindBlocks)
            }
        } else if (calculatedBehind < behindBlocks) {
            // Gradually decrease behindBlocks count
            behindBlocks = Math.max(calculatedBehind, behindBlocks - 1)
            
            // Update our sync status in shared state if significantly changed
            if (p2p && p2p.isNodeConnected() && Math.abs(calculatedBehind - behindBlocks) > 5) {
                p2p.broadcastSyncStatus(behindBlocks)
            }
        }

        // Don't change sync mode if we're in forced sync
        if (chain && chain.getLatestBlock() && chain.getLatestBlock()._id < forceSyncUntilBlock) {
            return latestSteemBlock
        }

        // More consensus-based sync mode management
        if (behindBlocks >= SYNC_THRESHOLD) {
            if (!isSyncing) {
                logr.info(`Entering sync mode, ${behindBlocks} blocks behind`)
                isSyncing = true
                lastSyncModeChange = Date.now()
                
                // Broadcast our sync mode change
                if (p2p && p2p.isNodeConnected()) {
                    p2p.broadcastSyncStatus(behindBlocks)
                }
            }
        } else {
            // Only exit sync mode if:
            // 1. We're currently in sync mode
            // 2. We've been in sync mode for the minimum cooldown period
            // 3. We're nearly caught up (fewer than SYNC_EXIT_THRESHOLD blocks behind) 
            // 4. We haven't exited sync mode recently
            // 5. Most nodes in the network are also caught up
            if (isSyncing && 
                Date.now() - lastSyncModeChange > SYNC_EXIT_COOLDOWN &&
                behindBlocks <= SYNC_EXIT_THRESHOLD &&
                (!lastSyncExitTime || Date.now() - lastSyncExitTime > SYNC_EXIT_COOLDOWN * 2) &&
                isNetworkReadyToExitSyncMode()) {
                
                logr.info(`Exiting sync mode - network consensus reached (${behindBlocks} blocks behind)`)
                isSyncing = false
                lastSyncModeChange = Date.now()
                lastSyncExitTime = Date.now()
                
                // Broadcast our sync mode change
                if (p2p && p2p.isNodeConnected()) {
                    p2p.broadcastSyncStatus(behindBlocks)
                }
            }
        }

        return latestSteemBlock
    } catch (error) {
        logr.error('Error updating Steem block state:', error)
        return null
    }
}

// Health monitoring
const checkApiHealth = async () => {
    try {
        const startTime = Date.now()
        const response = await client.database.getDynamicGlobalProperties()
        const latency = Date.now() - startTime

        if (!response) {
            healthCheckFailures++
            logr.warn(`API health check failed. Failure count: ${healthCheckFailures}`)
            return false
        }

        healthCheckFailures = 0
        logr.debug(`API health check passed. Latency: ${latency}ms`)
        return true
    } catch (err) {
        healthCheckFailures++
        logr.warn(`API health check failed: ${err.message}. Failure count: ${healthCheckFailures}`)
        return false
    }
}

// Circuit breaker check
const isCircuitBreakerOpen = () => {
    if (!circuitBreakerOpen) return false

    // Check if we should reset the circuit breaker
    if (Date.now() - lastCircuitBreakerTrip > CIRCUIT_BREAKER_RESET_TIMEOUT) {
        circuitBreakerOpen = false
        consecutiveErrors = 0
        retryDelay = MIN_RETRY_DELAY
        return false
    }
    return true
}

// Exponential backoff calculation
const calculateRetryDelay = () => {
    // Exponential backoff with jitter
    const baseDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY)
    const jitter = Math.random() * 1000
    retryDelay = baseDelay + jitter
    return retryDelay
}

// Reset error handling state
const resetErrorState = () => {
    consecutiveErrors = 0
    retryDelay = MIN_RETRY_DELAY
    if (circuitBreakerOpen) {
        circuitBreakerOpen = false
        healthCheckFailures = 0
    }
}

// Function to increment consecutive errors counter
const incrementConsecutiveErrors = () => {
    consecutiveErrors++

    // Check if we should trip the circuit breaker
    if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerOpen = true
        lastCircuitBreakerTrip = Date.now()
        logr.error('Circuit breaker tripped due to too many consecutive errors')
    }

    // Adjust retry delay if needed
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        retryDelay = calculateRetryDelay()
        logr.warn(`Consecutive errors threshold reached: ${consecutiveErrors}, next retry in ${Math.round(retryDelay)}ms`)
    }
}

// Function to reset consecutive errors
const resetConsecutiveErrors = () => {
    if (consecutiveErrors > 0) {
        consecutiveErrors = 0
        retryDelay = MIN_RETRY_DELAY
        logr.debug('Reset consecutive errors counter')
    }
}

// Initial interval
syncInterval = setInterval(updateSteemBlock, 3000)

const initPrefetch = (startBlock) => {
    // Initialize prefetching
    nextSteemBlock = startBlock

    // Start prefetch process
    prefetchTimer = setInterval(() => {
        if (prefetchInProgress) return
        prefetchBlocks()
    }, 1000)

    // Run first prefetch immediately
    prefetchBlocks()
}

const fetchMissingBlock = async (blockNum) => {
    // Function to fetch a specific Steem block that's missing from cache
    logr.info('Fetching missing Steem block:', blockNum)
    prefetchInProgress = true

    try {
        let retries = 3
        let steemBlock = null

        while (retries > 0) {
            try {
                steemBlock = await client.database.getBlock(blockNum)
                if (steemBlock) break
            } catch (err) {
                retries--
                if (retries === 0) throw err
                await new Promise(resolve => setTimeout(resolve, 1000))
            }
        }

        if (steemBlock) {
            // Cache the block for future reference
            blockCache.set(blockNum, steemBlock)
            logr.debug('Successfully fetched and cached missing block:', blockNum)
        } else {
            logr.error('Failed to fetch missing block after retries:', blockNum)
        }

        prefetchInProgress = false
        return steemBlock
    } catch (err) {
        prefetchInProgress = false
        logr.error('Error fetching missing block:', blockNum, err)
        return null
    }
}

// Function to get the latest Steem block number
const getLatestSteemBlockNum = async () => {
    try {
        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        return dynGlobalProps.head_block_number
    } catch (error) {
        logr.error('Error getting latest Steem block number:', error)
        return null
    }
}

function exitSyncMode() {
    // Do nothing - sync mode exit is handled in updateSteemBlock
    logr.debug('Sync mode exit requested but ignored - handled by updateSteemBlock')
}

// Add this new function to check RPC synchronization
const checkRpcSync = async () => {
    const now = Date.now()
    if (now - lastRpcCheck < RPC_CHECK_INTERVAL) return
    lastRpcCheck = now

    rpcBlockHeights.clear()
    let maxHeight = 0
    let minHeight = Infinity

    // Check each RPC endpoint
    for (let i = 0; i < apiUrls.length; i++) {
        try {
            const tempClient = new dsteem.Client(apiUrls[i], {
                failoverThreshold: 3,
                addressPrefix: 'STM',
                chainId: '0000000000000000000000000000000000000000000000000000000000000000'
            })
            
            const props = await tempClient.database.getDynamicGlobalProperties()
            const height = props.head_block_number
            rpcBlockHeights.set(apiUrls[i], height)
            
            maxHeight = Math.max(maxHeight, height)
            minHeight = Math.min(minHeight, height)
        } catch (error) {
            logr.warn(`Failed to check RPC sync for ${apiUrls[i]}:`, error)
        }
    }

    // If difference is too large, remove lagging RPCs
    if (maxHeight - minHeight > RPC_MAX_BLOCK_DIFF) {
        for (const [url, height] of rpcBlockHeights.entries()) {
            if (maxHeight - height > RPC_MAX_BLOCK_DIFF) {
                logr.warn(`RPC ${url} is ${maxHeight - height} blocks behind, temporarily removing from rotation`)
                // Remove this RPC from the current rotation
                apiUrls = apiUrls.filter(u => u !== url)
            }
        }
        
        // If we removed the current endpoint, switch to a better one
        if (!apiUrls.includes(client.address)) {
            switchToNextEndpoint()
        }
    }
}

// Add this new function to check network sync status
const checkNetworkSyncStatus = async () => {
    if (!p2p || !p2p.isNodeConnected()) return
    
    try {
        // Get sync status from peers via p2p
        const peerStatuses = await p2p.getSyncStatus()
        
        // Update our network sync status map
        if (peerStatuses && Array.isArray(peerStatuses)) {
            for (const status of peerStatuses) {
                if (status && status.nodeId && typeof status.behindBlocks === 'number') {
                    networkSyncStatus.set(status.nodeId, {
                        behindBlocks: status.behindBlocks,
                        isSyncing: status.isSyncing,
                        timestamp: Date.now()
                    })
                }
            }
        }
        
        // Clean up old statuses (older than 2 minutes)
        const twoMinutesAgo = Date.now() - 120000
        for (const [nodeId, status] of networkSyncStatus.entries()) {
            if (status.timestamp < twoMinutesAgo) {
                networkSyncStatus.delete(nodeId)
            }
        }
        
        // Log current network sync status
        logr.debug(`Network sync status: ${networkSyncStatus.size} nodes reporting`)
        let syncCount = 0
        let caughtUpCount = 0
        
        for (const status of networkSyncStatus.values()) {
            if (status.isSyncing) syncCount++
            if (status.behindBlocks <= SYNC_EXIT_THRESHOLD) caughtUpCount++
        }
        
        logr.debug(`Nodes in sync mode: ${syncCount}, Nodes caught up: ${caughtUpCount}`)
    } catch (error) {
        logr.error('Error checking network sync status:', error)
    }
}

// Add this function to determine if network is ready to exit sync mode
const isNetworkReadyToExitSyncMode = () => {
    // If no network data, use local decision
    if (networkSyncStatus.size === 0) {
        return behindBlocks <= SYNC_EXIT_THRESHOLD
    }
    
    // Count how many nodes are caught up 
    let caughtUpCount = 0
    let totalNodes = networkSyncStatus.size
    
    // Include ourselves in the count
    if (behindBlocks <= SYNC_EXIT_THRESHOLD) {
        caughtUpCount++
    }
    totalNodes++
    
    // Count other nodes
    for (const status of networkSyncStatus.values()) {
        if (status.behindBlocks <= SYNC_EXIT_THRESHOLD) {
            caughtUpCount++
        }
    }
    
    // Calculate percentage
    const caughtUpPercent = (caughtUpCount / totalNodes) * 100
    
    logr.debug(`Network sync exit check: ${caughtUpCount}/${totalNodes} nodes caught up (${caughtUpPercent.toFixed(1)}%)`)
    
    // Return true if enough nodes are caught up
    return caughtUpPercent >= SYNC_EXIT_QUORUM_PERCENT
}

module.exports = {
    init: (blockNum) => {
        nextSteemBlock = blockNum
        currentSteemBlock = blockNum

        // Clear existing intervals if any
        if (syncInterval) clearInterval(syncInterval)

        // Initialize behindBlocks properly
        getLatestSteemBlockNum().then(latestBlock => {
            if (latestBlock) {
                // Get the Steem block from our last chain block
                let lastProcessedSteemBlock = 0
                if (chain && chain.getLatestBlock() && chain.getLatestBlock().steemblock) {
                    lastProcessedSteemBlock = chain.getLatestBlock().steemblock
                } else if (config.steemStartBlock) {
                    lastProcessedSteemBlock = config.steemStartBlock
                } else {
                    lastProcessedSteemBlock = blockNum
                }

                behindBlocks = Math.max(0, latestBlock - lastProcessedSteemBlock)
                logr.info(`Initial blocks behind: ${behindBlocks} (Steem head: ${latestBlock}, Last processed: ${lastProcessedSteemBlock})`)

                // Set more frequent updates if we're behind
                if (behindBlocks > SYNC_THRESHOLD) {
                    syncInterval = setInterval(updateSteemBlock, 1000); // Update more frequently during sync
                    logr.info(`Setting faster sync status updates (every 1s) while catching up`);
                } else {
                    syncInterval = setInterval(updateSteemBlock, 3000); // Normal update interval
                }
                
                // Initialize network sync status check
                lastNetworkSyncCheck = Date.now()
                checkNetworkSyncStatus()
            }
        }).catch(err => {
            logr.error('Error initializing behind blocks count:', err)
            // Set default interval as fallback
            syncInterval = setInterval(updateSteemBlock, 3000)
        })

        // Run an immediate state update
        updateSteemBlock().then(() => {
            // Start prefetching immediately
            prefetchBlocks()
        }).catch(err => {
            logr.error('Error during initial Steem state update:', err)
        })

        // Initialize the prefetch system
        initPrefetch(blockNum)

        logr.info('Steem subsystem initialized at block', blockNum)
    },
    getCurrentBlock: () => {
        return currentSteemBlock
    },
    isSyncing: () => {
        // Check if we're forced into sync mode by a recent block
        if (chain && chain.getLatestBlock() && chain.getLatestBlock()._id < forceSyncUntilBlock) {
            return true
        }
        return isSyncing
    },
    getBehindBlocks: () => {
        return behindBlocks
    },
    updateNetworkBehindBlocks: (newValue) => {
        if (typeof newValue === 'number' && newValue > behindBlocks) {
            behindBlocks = newValue
            // If we get an update that we're significantly behind, consider entering sync mode
            if (behindBlocks >= SYNC_THRESHOLD && !isSyncing) {
                logr.info(`Entering sync mode based on network report, ${behindBlocks} blocks behind`)
                isSyncing = true
                
                // Broadcast our sync mode change
                if (p2p && p2p.isNodeConnected()) {
                    p2p.broadcastSyncStatus(behindBlocks)
                }
            }
        }
    },
    setSyncMode: (blockHeight) => {
        // Only enter sync mode if we're actually behind
        if (behindBlocks > 0) {
            if (!isSyncing) {
                isSyncing = true
                logr.info('Network-enforced sync mode enabled')
                
                // Broadcast our sync mode change
                if (p2p && p2p.isNodeConnected()) {
                    p2p.broadcastSyncStatus(behindBlocks)
                }
            }
        }
    },
    receivePeerSyncStatus: (nodeId, status) => {
        // Store peer sync status
        if (nodeId && status && typeof status.behindBlocks === 'number') {
            networkSyncStatus.set(nodeId, {
                behindBlocks: status.behindBlocks,
                isSyncing: status.isSyncing,
                timestamp: Date.now()
            })
        }
    },
    getSyncStatus: () => {
        // Return our current sync status for broadcasting to peers
        return {
            behindBlocks: behindBlocks,
            isSyncing: isSyncing
        }
    },
    isOnSteemBlock: (block) => {
        return new Promise(async (resolve, reject) => {
            try {
                // Try to get the block from cache
                let steemBlock = blockCache.get(block.steemblock)

                // If block not in cache, try to fetch it
                if (!steemBlock) {
                    logr.warn(`Steem block ${block.steemblock} not found in cache, attempting to fetch it`)
                    steemBlock = await module.exports.fetchMissingBlock(block.steemblock)

                    // If still can't get the block, resolve with false
                    if (!steemBlock) {
                        logr.error(`Could not fetch Steem block ${block.steemblock} after attempts`)
                        return resolve(false)
                    }
                }

                // If we have no transactions to validate, return true
                if (!block.txs || block.txs.length === 0) {
                    return resolve(true)
                }

                // Check each transaction in our block against Steem block
                for (let tx of block.txs) {
                    if (tx.type !== 'custom_json')
                        continue

                    // Find matching custom_json operation in Steem block
                    let found = false
                    for (let steemTx of steemBlock.transactions) {
                        try {
                            for (let op of steemTx.operations) {
                                if (op[0] !== 'custom_json')
                                    continue

                                if (op[1].id === 'sidechain' &&
                                    op[1].json === JSON.stringify({
                                        contract: tx.data.contract,
                                        payload: tx.data.payload
                                    })) {
                                    found = true
                                    break
                                }
                            }
                            if (found) break
                        } catch (txErr) {
                            logr.error('Error processing transaction in Steem block:', txErr)
                            // Continue processing other transactions
                        }
                    }

                    if (!found) {
                        logr.warn(`Transaction not found in Steem block ${block.steemblock}`)
                        return resolve(false)
                    }
                }

                return resolve(true)
            } catch (err) {
                logr.error('Error in isOnSteemBlock:', err)
                return resolve(false) // Resolve with false instead of rejecting to prevent unhandled rejections
            }
        })
    },
    processBlock: processBlock,
    initPrefetch,
    fetchMissingBlock,
    prefetchBlocks,
    setReadyToReceiveTransactions,
    exitSyncMode,
    lastSyncExitTime: lastSyncExitTime,
    getNetworkSyncStatus: () => {
        // Return array of nodes and their sync status
        const result = []
        for (const [nodeId, status] of networkSyncStatus.entries()) {
            result.push({
                nodeId,
                behindBlocks: status.behindBlocks,
                isSyncing: status.isSyncing,
                lastUpdate: new Date(status.timestamp).toISOString()
            })
        }
        return result
    }
}

