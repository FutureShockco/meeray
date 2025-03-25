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

    for (const [url, height] of rpcHeightData.entries()) {
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
const TARGET_BEHIND_BLOCKS = 2  // Target number of blocks to stay behind Steem
const MAX_BEHIND_BLOCKS = 5     // Maximum blocks behind before entering sync mode
const SYNC_EXIT_COOLDOWN = 6000 // Cooldown before exiting sync mode
const SYNC_EXIT_THRESHOLD = 3   // Exit sync when we're at most this many blocks behind
const SYNC_BROADCAST_MODULO = 3 // Only broadcast sync status every N sidechain blocks

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

// Constants for RPC checks
const RPC_CHECK_INTERVAL_NORMAL = 10000  // 10 seconds in normal mode
const RPC_CHECK_INTERVAL_SYNC = 3000     // 3 seconds in sync mode
const RPC_HEIGHT_EXPIRY = 30000          // Expire RPC heights after 30 seconds

// Track RPC heights with timestamps
const rpcHeightData = new Map() // Store both height and timestamp

// Add new tracking variables at the top
let networkSteemHeights = new Map() // Track each node's latest Steem block height
const STEEM_HEIGHT_EXPIRY = 30000 // Expire Steem heights older than 30 seconds

// Add RPC tracking variables
let lastRpcCheck = 0
let networkSyncStatus = new Map() // Track other nodes' sync status
let lastNetworkSyncCheck = 0
const NETWORK_SYNC_CHECK_INTERVAL = 15000 // Check network sync status every 15 seconds
const SYNC_EXIT_QUORUM_PERCENT = 60 // Require 60% of nodes to be caught up before exiting sync mode
const RPC_MAX_BLOCK_DIFF = 5 // Maximum allowed difference between RPCs

// Add new constants at the top with other constants
const WARMUP_PERIOD = 5000 // 5 seconds warmup for new nodes
const BEHIND_BLOCKS_CONSENSUS_THRESHOLD = 0.66 // 66% of nodes must agree on behind blocks count
const MIN_NODES_FOR_CONSENSUS = 2 // Minimum nodes needed for consensus

// Add new state variables
let nodeStartTime = Date.now()
let networkConsensusBlocks = null

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
        blocksToPrefetch = MAX_PREFETCH_BLOCKS * 8
    }

    // Additional prefetching when we're very far behind
    const localBehindBlocks = latestSteemBlock - currentBlock
    if (localBehindBlocks > TARGET_BEHIND_BLOCKS * 5) {
        blocksToPrefetch = MAX_PREFETCH_BLOCKS * 5
        logr.debug(`Very far behind (${localBehindBlocks} blocks) - aggressive prefetching ${blocksToPrefetch} blocks`)
    }

    // Limit prefetch to the number of blocks we're behind
    blocksToPrefetch = Math.min(blocksToPrefetch, latestSteemBlock - currentBlock)

    if (blocksToPrefetch <= 0) {
        prefetchInProgress = false
        return
    }

    let missedBlocks = 0
    let processedFirstBlock = false

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
                        processedFirstBlock = true
                    }
                } else {
                    missedBlocks++
                    logr.warn(`No data returned for Steem block ${blockToFetch}`)
                    
                    // If this is the first block and we couldn't get it, try to move past it
                    // after a few attempts to avoid getting stuck
                    if (i === 0 && !processedFirstBlock) {
                        if (consecutiveErrors > 3) {
                            logr.warn(`Skipping problematic block ${blockToFetch} after multiple failures`)
                            nextSteemBlock = blockToFetch + 1
                            resetConsecutiveErrors()
                        } else {
                            incrementConsecutiveErrors()
                        }
                    }
                }
            } catch (error) {
                missedBlocks++
                incrementConsecutiveErrors()
                logr.warn(`Failed to prefetch Steem block ${blockToFetch}:`, error)
                
                // If this is the first block and we've been stuck for a while, try to move past it
                if (i === 0 && !processedFirstBlock && consecutiveErrors > 5) {
                    logr.warn(`Moving past problematic block ${blockToFetch} after ${consecutiveErrors} consecutive errors`)
                    nextSteemBlock = blockToFetch + 1
                    resetConsecutiveErrors()
                }
            }
        }

        // If we've missed too many blocks, try switching endpoints
        if (missedBlocks > blocksToPrefetch / 2) {
            logr.warn(`Missed ${missedBlocks}/${blocksToPrefetch} blocks, switching RPC endpoint`)
            switchToNextEndpoint()
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
                if (steemBlock) {
                    // Cache the block
                    blockCache.set(blockNum, steemBlock)
                    // Limit cache size
                    if (blockCache.size > MAX_PREFETCH_BLOCKS * 2) {
                        // Delete oldest entries (approximate LRU)
                        const keysToDelete = Array.from(blockCache.keys()).slice(0, MAX_PREFETCH_BLOCKS)
                        keysToDelete.forEach(key => blockCache.delete(key))
                    }
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
            return Promise.resolve(null)
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

// Function to get network's view of sync status
const getNetworkSyncStatus = () => {
    const now = Date.now()
    let highestNode = null
    let highestBlock = 0
    let referenceNodeId = null

    // Clean up expired entries
    for (const [nodeId, data] of networkSteemHeights.entries()) {
        if (now - data.timestamp > STEEM_HEIGHT_EXPIRY) {
            networkSteemHeights.delete(nodeId)
            networkSyncStatus.delete(nodeId)
        }
    }

    // Find the node with highest Steem block
    for (const [nodeId, data] of networkSteemHeights.entries()) {
        if (data.steemBlock > highestBlock) {
            highestBlock = data.steemBlock
            highestNode = data
            referenceNodeId = nodeId
        }
    }

    // If we have a higher block, we become the reference
    const ourSteemBlock = currentSteemBlock
    if (ourSteemBlock > highestBlock) {
        highestBlock = ourSteemBlock
        highestNode = {
            steemBlock: ourSteemBlock,
            behindBlocks: behindBlocks
        }
        referenceNodeId = 'self'
    }

    if (!highestNode) {
        return {
            referenceExists: false,
            referenceBehind: behindBlocks,
            referenceNodeId: 'self',
            highestBlock: currentSteemBlock
        }
    }

    return {
        referenceExists: true,
        referenceBehind: highestNode.behindBlocks,
        referenceNodeId: referenceNodeId,
        highestBlock: highestBlock
    }
}

const getMedian = (numbers) => {
    const sorted = Array.from(numbers).sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2
    }
    return sorted[middle]
}

const getValidRpcHeights = () => {
    const now = Date.now()
    const validHeights = []
    
    // Clean up expired entries and collect valid heights
    for (const [url, data] of rpcHeightData.entries()) {
        if (now - data.timestamp > RPC_HEIGHT_EXPIRY) {
            rpcHeightData.delete(url)
            logr.debug(`Expired RPC height data for ${url}`)
        } else {
            validHeights.push(data.height)
        }
    }
    
    return validHeights
}

const checkRpcSync = async () => {
    const now = Date.now()
    const checkInterval = isSyncing ? RPC_CHECK_INTERVAL_SYNC : RPC_CHECK_INTERVAL_NORMAL
    
    // If it's not time to check RPCs, return current median from valid heights
    if (now - lastRpcCheck < checkInterval) {
        const validHeights = getValidRpcHeights()
        if (validHeights.length > 0) {
            const currentMedian = getMedian(validHeights)
            logr.debug(`Using cached median height: ${currentMedian} (from ${validHeights.length} RPCs)`)
            return currentMedian
        }
        return null
    }
    
    lastRpcCheck = now
    let lowestHeight = Infinity
    let highestHeight = 0

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
            
            // Store height with timestamp
            rpcHeightData.set(apiUrls[i], {
                height: height,
                timestamp: now
            })
            
            lowestHeight = Math.min(lowestHeight, height)
            highestHeight = Math.max(highestHeight, height)

            logr.debug(`RPC ${apiUrls[i]} at height ${height}`)
        } catch (error) {
            logr.warn(`Failed to check RPC sync for ${apiUrls[i]}:`, error)
        }
    }

    // Get valid heights after updating
    const validHeights = getValidRpcHeights()
    
    // If we have no valid RPCs, return null
    if (validHeights.length === 0) {
        logr.error('No valid RPC responses received')
        return null
    }

    // Calculate median height
    const medianHeight = getMedian(validHeights)

    // Log height distribution
    logr.debug(`RPC heights - Lowest: ${lowestHeight}, Median: ${medianHeight}, Highest: ${highestHeight}, Valid RPCs: ${validHeights.length}`)

    // If difference between highest and lowest is too large, log a warning
    if (highestHeight - lowestHeight > RPC_MAX_BLOCK_DIFF) {
        logr.warn(`Large block height difference between RPCs: ${highestHeight - lowestHeight} blocks`)
        logr.warn(`Using median height: ${medianHeight} for sync decisions`)
    }

    return medianHeight
}

// Add new function to calculate network consensus on behind blocks
const calculateNetworkBehindBlocksConsensus = () => {
    if (networkSteemHeights.size < MIN_NODES_FOR_CONSENSUS) {
        return null
    }

    // Get all behind blocks counts
    const behindBlocksCounts = new Map()
    for (const [nodeId, data] of networkSteemHeights.entries()) {
        if (Date.now() - data.timestamp < STEEM_HEIGHT_EXPIRY) {
            const count = data.behindBlocks
            behindBlocksCounts.set(count, (behindBlocksCounts.get(count) || 0) + 1)
        }
    }

    // Find the most common behind blocks count
    let maxCount = 0
    let consensusValue = null
    for (const [blocks, count] of behindBlocksCounts.entries()) {
        if (count > maxCount) {
            maxCount = count
            consensusValue = blocks
        }
    }

    // Check if we have consensus
    const consensusPercentage = maxCount / networkSteemHeights.size
    if (consensusPercentage >= BEHIND_BLOCKS_CONSENSUS_THRESHOLD) {
        return consensusValue
    }

    return null
}

// Modify updateSteemBlock to include warmup period and consensus
const updateSteemBlock = async () => {
    try {
        // Check if we're still in warmup period
        const isInWarmup = Date.now() - nodeStartTime < WARMUP_PERIOD
        
        // Get the median RPC height for sync decisions
        const medianRpcHeight = await checkRpcSync()
        
        // Check network sync status periodically
        const now = Date.now()
        if (now - lastNetworkSyncCheck > NETWORK_SYNC_CHECK_INTERVAL) {
            await checkNetworkSyncStatus()
            lastNetworkSyncCheck = now
        }
        
        // Get our last processed Steem block
        let lastProcessedSteemBlock = 0
        if (chain && chain.getLatestBlock() && chain.getLatestBlock().steemblock) {
            lastProcessedSteemBlock = chain.getLatestBlock().steemblock
        } else if (config.steemStartBlock) {
            lastProcessedSteemBlock = config.steemStartBlock
        }

        // Update currentSteemBlock
        currentSteemBlock = Math.max(currentSteemBlock, lastProcessedSteemBlock)

        // Calculate local behind blocks using median RPC height
        const latestSteemBlock = medianRpcHeight || (await client.database.getDynamicGlobalProperties()).head_block_number
        const localBehindBlocks = Math.max(0, latestSteemBlock - lastProcessedSteemBlock)
        
        // Get network's view of sync status
        const networkStatus = getNetworkSyncStatus()

        // Calculate network consensus on behind blocks
        const consensusBehindBlocks = calculateNetworkBehindBlocksConsensus()
        
        // Update behindBlocks based on network consensus, reference node, or local calculation
        if (isInWarmup) {
            // During warmup, use the maximum of consensus, reference, or local
            if (consensusBehindBlocks !== null) {
                behindBlocks = Math.max(consensusBehindBlocks, localBehindBlocks)
                logr.debug(`Warmup: Using consensus behind blocks: ${behindBlocks} (consensus: ${consensusBehindBlocks}, local: ${localBehindBlocks})`)
            } else if (networkStatus.referenceExists) {
                behindBlocks = Math.max(networkStatus.referenceBehind, localBehindBlocks)
                logr.debug(`Warmup: Using reference behind blocks: ${behindBlocks} (reference: ${networkStatus.referenceNodeId}, local: ${localBehindBlocks})`)
            } else {
                behindBlocks = localBehindBlocks
                logr.debug(`Warmup: Using local behind blocks: ${behindBlocks}`)
            }
        } else {
            // After warmup, prioritize consensus > reference node > local calculation
            if (consensusBehindBlocks !== null) {
                behindBlocks = consensusBehindBlocks
                logr.debug(`Using network consensus behind blocks: ${behindBlocks} (consensus from ${networkSteemHeights.size} nodes)`)
            } else if (networkStatus.referenceExists) {
                behindBlocks = networkStatus.referenceBehind
                logr.debug(`Using reference behind blocks: ${behindBlocks} (reference: ${networkStatus.referenceNodeId})`)
            } else {
                behindBlocks = localBehindBlocks
                logr.debug(`Using local behind blocks: ${behindBlocks} (no consensus or reference available)`)
            }
        }

        // Only broadcast sync status on specific block intervals
        const currentBlockId = chain?.getLatestBlock()?._id || 0
        const shouldBroadcast = currentBlockId % SYNC_BROADCAST_MODULO === 0

        // Update our sync status in shared state
        if (p2p && p2p.sockets && p2p.sockets.length > 0 && shouldBroadcast) {
            logr.debug(`Broadcasting sync status on block ${currentBlockId} (modulo ${SYNC_BROADCAST_MODULO})`)
            p2p.broadcastSyncStatus({
                behindBlocks: behindBlocks,
                steemBlock: currentSteemBlock,
                isSyncing: isSyncing,
                blockId: currentBlockId,
                consensusBlocks: consensusBehindBlocks,
                isInWarmup: isInWarmup
            })
        }

        // Don't change sync mode if we're in forced sync
        if (chain && chain.getLatestBlock() && chain.getLatestBlock()._id < forceSyncUntilBlock) {
            return latestSteemBlock
        }

        // Enter sync mode if we're more than MAX_BEHIND_BLOCKS behind
        const shouldSync = behindBlocks > MAX_BEHIND_BLOCKS || 
                         !readyToReceiveTransactions

        if (shouldSync) {
            if (!isSyncing) {
                logr.info(`Entering sync mode: ${behindBlocks} blocks behind (target: ${TARGET_BEHIND_BLOCKS}, max: ${MAX_BEHIND_BLOCKS})`)
                isSyncing = true
                lastSyncModeChange = Date.now()
            }
        } else if (isSyncing && 
            Date.now() - lastSyncModeChange > SYNC_EXIT_COOLDOWN &&
            (!lastSyncExitTime || Date.now() - lastSyncExitTime > SYNC_EXIT_COOLDOWN * 2) &&
            behindBlocks <= SYNC_EXIT_THRESHOLD &&
            shouldBroadcast) { // Only exit sync mode on broadcast blocks
            
            logr.info(`Exiting sync mode - within target range (${behindBlocks} blocks behind, target: ${TARGET_BEHIND_BLOCKS}, block: ${currentBlockId})`)
            isSyncing = false
            lastSyncModeChange = Date.now()
            lastSyncExitTime = Date.now()
        }

        // If we're too close to head, slow down processing
        if (behindBlocks < TARGET_BEHIND_BLOCKS) {
            logr.debug(`Too close to Steem head (${behindBlocks} blocks), slowing down processing`)
            await new Promise(resolve => setTimeout(resolve, 1000))
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
        let retries = 5 // Increase retries from 3 to 5
        let steemBlock = null

        while (retries > 0) {
            try {
                // Try the current endpoint
                steemBlock = await client.database.getBlock(blockNum)
                if (steemBlock) break
            } catch (err) {
                logr.warn(`Error fetching block ${blockNum} (${retries} retries left): ${err.message}`)
                
                if (retries === 3) {
                    // Switch endpoints after a couple of failures
                    switchToNextEndpoint()
                    logr.info(`Switched RPC endpoint while fetching block ${blockNum}`)
                }
                
                retries--
                if (retries === 0) throw err
                await new Promise(resolve => setTimeout(resolve, 2000)) // Increase retry delay to 2 seconds
            }
        }

        if (steemBlock) {
            // Cache the block for future reference
            blockCache.set(blockNum, steemBlock)
            logr.debug('Successfully fetched and cached missing block:', blockNum)
        } else {
            logr.error('Failed to fetch missing block after retries:', blockNum)
            return null
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
        if (dynGlobalProps && dynGlobalProps.head_block_number) {
            return dynGlobalProps.head_block_number
        } else {
            throw new Error('Invalid response from getDynamicGlobalProperties')
        }
    } catch (error) {
        logr.warn('Error getting latest Steem block number:', error)
        
        // Try switching endpoints and try again
        if (switchToNextEndpoint()) {
            try {
                logr.info('Trying alternate endpoint for getLatestSteemBlockNum')
                const dynGlobalProps = await client.database.getDynamicGlobalProperties()
                if (dynGlobalProps && dynGlobalProps.head_block_number) {
                    return dynGlobalProps.head_block_number
                }
            } catch (retryError) {
                logr.error('Error with alternate endpoint for getLatestSteemBlockNum:', retryError)
            }
        }
        
        // If we have cached RPC heights, use the highest one
        if (rpcHeightData.size > 0) {
            const highestBlockHeight = Math.max(...rpcHeightData.values())
            if (highestBlockHeight > 0) {
                logr.info(`Using cached highest RPC block height: ${highestBlockHeight}`)
                return highestBlockHeight
            }
        }
        
        return null
    }
}

function exitSyncMode() {
    // Do nothing - sync mode exit is handled in updateSteemBlock
    logr.debug('Sync mode exit requested but ignored - handled by updateSteemBlock')
}

// Add this new function to check network sync status
const checkNetworkSyncStatus = async () => {
    // Check if p2p exists and has connected sockets
    if (!p2p || !p2p.sockets || p2p.sockets.length === 0) return
    
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
                        timestamp: Date.now(),
                        blockId: status.blockId,
                        consensusBlocks: status.consensusBlocks,
                        isInWarmup: status.isInWarmup
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

// Update the receivePeerSyncStatus function to track Steem heights
const receivePeerSyncStatus = (nodeId, status) => {
    if (nodeId && status) {
        if (typeof status.behindBlocks === 'number') {
            networkSyncStatus.set(nodeId, {
                behindBlocks: status.behindBlocks,
                isSyncing: status.isSyncing,
                timestamp: Date.now(),
                blockId: status.blockId,
                consensusBlocks: status.consensusBlocks,
                isInWarmup: status.isInWarmup
            })
        }
        if (typeof status.steemBlock === 'number') {
            networkSteemHeights.set(nodeId, {
                steemBlock: status.steemBlock,
                behindBlocks: status.behindBlocks,
                timestamp: Date.now(),
                blockId: status.blockId,
                consensusBlocks: status.consensusBlocks,
                isInWarmup: status.isInWarmup
            })
        }
    }
}

// Update the getSyncStatus function to include Steem block
const getSyncStatus = () => {
    // Return our current sync status for broadcasting to peers
    return {
        behindBlocks: behindBlocks,
        steemBlock: currentSteemBlock,
        isSyncing: isSyncing
    }
}

// Update isNetworkReadyToExitSyncMode to use reference node
const isNetworkReadyToExitSyncMode = () => {
    const networkStatus = getNetworkSyncStatus()
    
    // If we're not the reference node, we ONLY exit when the reference node exits
    if (networkStatus.referenceExists && networkStatus.referenceNodeId !== 'self') {
        // Find reference node's sync status
        const referenceStatus = networkSyncStatus.get(networkStatus.referenceNodeId)
        if (referenceStatus) {
            // Only exit if reference node is not in sync mode
            if (referenceStatus.isSyncing) {
                logr.debug(`Staying in sync mode - reference node ${networkStatus.referenceNodeId} is still syncing`)
                return false
            }
            // Exit only if reference node has exited recently (within last 5 seconds)
            const timeSinceReferenceExit = Date.now() - referenceStatus.timestamp
            if (timeSinceReferenceExit > 5000) {
                logr.debug(`Reference node sync status too old (${timeSinceReferenceExit}ms), staying in sync mode`)
                return false
            }
            logr.debug(`Following reference node ${networkStatus.referenceNodeId} to exit sync mode`)
            return true
        }
        logr.debug('Reference node status not found, staying in sync mode')
        return false
    }

    // If we're the reference node (or no reference exists), we make the decision
    if (behindBlocks > 0) {
        logr.debug('As reference node, staying in sync mode with behindBlocks > 0')
        return false
    }

    // Count how many nodes are caught up
    let syncedCount = 1 // Include ourselves
    let totalNodes = networkSyncStatus.size + 1
    let maxBehind = 0

    // Check other nodes
    for (const [nodeId, status] of networkSteemHeights.entries()) {
        if (Math.abs(status.steemBlock - currentSteemBlock) <= 1) {
            syncedCount++
        }
        maxBehind = Math.max(maxBehind, status.behindBlocks)
    }

    const syncedPercent = (syncedCount / totalNodes) * 100

    logr.debug(`Reference node sync status check:
        - Nodes synced: ${syncedCount}/${totalNodes} (${syncedPercent.toFixed(1)}%)
        - Max behind: ${maxBehind}
        - Current block: ${currentSteemBlock}`)

    // As reference node, require stricter conditions
    const readyToExit = syncedPercent >= SYNC_EXIT_QUORUM_PERCENT && 
                       maxBehind <= 1 && // More strict: require nodes to be at most 1 block behind
                       behindBlocks === 0;

    if (readyToExit) {
        logr.info('As reference node, signaling network to exit sync mode')
    }

    return readyToExit
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
                if (behindBlocks > TARGET_BEHIND_BLOCKS) {
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
            if (behindBlocks >= TARGET_BEHIND_BLOCKS && !isSyncing) {
                logr.info(`Entering sync mode based on network report, ${behindBlocks} blocks behind`)
                isSyncing = true
                
                // Broadcast our sync mode change
                if (p2p && p2p.sockets && p2p.sockets.length > 0) {
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
                if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                    p2p.broadcastSyncStatus(behindBlocks)
                }
            }
        }
    },
    receivePeerSyncStatus: receivePeerSyncStatus,
    getSyncStatus: getSyncStatus,
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

