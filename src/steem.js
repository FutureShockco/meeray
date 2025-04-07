const dsteem = require('dsteem')
// Setup multiple endpoints with manual failover
const apiUrls = process.env.STEEM_API ? process.env.STEEM_API.split(',').map(url => url.trim()) : ['https://api.steemit.com']
logr.info('Using Steem API URLs:', apiUrls)

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

let currentSteemBlock = 0
let processingBlocks = []
let isSyncing = false
let syncInterval = null
let behindBlocks = 0
const MAX_CONSECUTIVE_ERRORS = 20
const MIN_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 15000
const CIRCUIT_BREAKER_THRESHOLD = 30
const CIRCUIT_BREAKER_RESET_TIMEOUT = 30000
const PREFETCH_BLOCKS = 1  // Maximum number of blocks to prefetch at once
const MAX_PREFETCH_BLOCKS = 10  // Maximum number of blocks to prefetch at once

const SYNC_EXIT_THRESHOLD = 3   // Exit sync when we're at most this many blocks behind

// Track when to exit sync mode
let syncExitTargetBlock = null  // Target block to exit sync mode
let exitCount = 0
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

// Define updateNetworkBehindBlocks function before it's used
const updateNetworkBehindBlocks = (newValue) => {
    if (typeof newValue === 'number') {
        const oldValue = behindBlocks
        behindBlocks = newValue

        // Log the change
        logr.debug(`Behind blocks updated: ${oldValue} -> ${newValue}`)

        // Calculate consensus behind blocks value from network
        const behindBlocksCounts = [behindBlocks]
        
        // Collect behind blocks counts from connected peers
        for (const [nodeId, data] of networkSyncStatus.entries()) {
            if (typeof data.behindBlocks === 'number' && Date.now() - data.timestamp < 30000) {
                behindBlocksCounts.push(data.behindBlocks)
            }
        }
        
        // Calculate median behind blocks count as consensus
        let consensusBehind = behindBlocks
        if (behindBlocksCounts.length > 1) {
            behindBlocksCounts.sort((a, b) => a - b)
            const midIndex = Math.floor(behindBlocksCounts.length / 2)
            consensusBehind = behindBlocksCounts.length % 2 === 0
                ? Math.round((behindBlocksCounts[midIndex - 1] + behindBlocksCounts[midIndex]) / 2)
                : behindBlocksCounts[midIndex]
            
            logr.debug(`Network consensus behind blocks: ${consensusBehind}, counts: ${behindBlocksCounts.join(',')}`)
        }

        // If consensus shows we're significantly behind, consider entering sync mode
        if (consensusBehind >= config.steemBlockDelay * 5 && !isSyncing) {
            logr.warn(`Entering sync mode based on network consensus, ${consensusBehind} blocks behind (local: ${behindBlocks})`)
            isSyncing = true
            // Reset exit target when entering sync mode
            syncExitTargetBlock = null
            
            // Reset the post-sync behind blocks tracking
            if (chain && exitCount < 1) {
                chain.totalPostSyncBehind = 0;
                chain.postSyncBehindCount = 0;
                chain.avgPostSyncBehind = 0;
                logr.debug('Reset post-sync behind block tracking statistics');
            }

            // Broadcast our sync mode change with consensus value
            if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                p2p.broadcastSyncStatus({
                    behindBlocks: behindBlocks,
                    isSyncing: true,
                    blockId: chain?.getLatestBlock()?._id || 0,
                    steemBlock: currentSteemBlock,
                    consensusBlocks: consensusBehind,
                    exitTarget: null // Clear any previous exit target
                })
            }
        }
        // Check if we're caught up and in sync mode - possible exit condition
        else if (isSyncing) {
            // We already calculated consensus above, so just use it directly
            
            // Use consensus value for exit decisions
            const latestBlock = chain?.getLatestBlock()
            if (!latestBlock) return
            
            // Set exit target only when consensus says we're caught up
            if (consensusBehind <= config.steemBlockDelay * 3 && !syncExitTargetBlock) {
                // Set exit in two blocks
                syncExitTargetBlock = latestBlock._id + config.steemBlockDelay
                logr.warn(`Network consensus shows we're caught up (${consensusBehind} blocks behind). Setting exit target to next block ${syncExitTargetBlock}`)
                
                // Broadcast our target
                if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                    p2p.broadcastSyncStatus({
                        behindBlocks: behindBlocks,
                        steemBlock: latestBlock.steemblock,
                        isSyncing: true,
                        blockId: latestBlock._id,
                        consensusBlocks: consensusBehind,
                        exitTarget: syncExitTargetBlock
                    })
                }
            }
            // Clear exit target if consensus changes to not caught up
            else if (consensusBehind > 1 && syncExitTargetBlock) {
                logr.info(`Network consensus shows we're behind (${consensusBehind} blocks). Clearing exit target.`)
                syncExitTargetBlock = null
                
                // Broadcast our updated status
                if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                    p2p.broadcastSyncStatus({
                        behindBlocks: behindBlocks,
                        steemBlock: latestBlock.steemblock, 
                        isSyncing: true,
                        blockId: latestBlock._id,
                        consensusBlocks: consensusBehind,
                        exitTarget: null
                    })
                }
            }
        }
    }
}

// Helper function to check sync status
const isInSyncMode = () => {
    return isSyncing
}

// Helper to check if we should exit sync mode based on target block
const shouldExitSyncMode = (currentBlockId) => {
    if (!isSyncing) return false
    
    // Calculate consensus behind blocks value from network
    const behindBlocksCounts = [behindBlocks]
    let highestBehind = behindBlocks
    let lowestBehind = behindBlocks
    
    // Collect behind blocks counts from connected peers
    for (const [nodeId, data] of networkSyncStatus.entries()) {
        if (typeof data.behindBlocks === 'number' && Date.now() - data.timestamp < 30000) {
            behindBlocksCounts.push(data.behindBlocks)
            highestBehind = Math.max(highestBehind, data.behindBlocks)
            lowestBehind = Math.min(lowestBehind, data.behindBlocks)
        }
    }
    
    // Calculate median behind blocks count as consensus
    let consensusBehind = behindBlocks
    if (behindBlocksCounts.length > 1) {
        behindBlocksCounts.sort((a, b) => a - b)
        const midIndex = Math.floor(behindBlocksCounts.length / 2)
        consensusBehind = behindBlocksCounts.length % 2 === 0
            ? Math.round((behindBlocksCounts[midIndex - 1] + behindBlocksCounts[midIndex]) / 2)
            : behindBlocksCounts[midIndex]
            
        logr.debug(`Consensus behind blocks: ${consensusBehind}, range: ${lowestBehind}-${highestBehind}, counts: ${behindBlocksCounts.join(',')}`)
    }
    
    // ONLY use the consensus behind blocks count for exit decision
    if (consensusBehind <= config.steemBlockDelay) {
        logr.info(`Network consensus shows we're caught up (${consensusBehind} blocks behind). Exiting sync mode at block ${currentBlockId}`)
        return true
    }
    
    // If consensus says we're still behind, don't exit
    if (consensusBehind > config.steemBlockDelay) {
        // If we have a target block but consensus says we're still behind, clear the target
        if (syncExitTargetBlock) {
            logr.info(`Clearing sync exit target. Consensus shows we're still ${consensusBehind} blocks behind`)
            syncExitTargetBlock = null
        }
        return false
    }

    // Special case: if all nodes have minimal range and agree we're caught up
    // This helps when the network is in full agreement
    if (behindBlocksCounts.length >= 3 && highestBehind <= config.steemBlockDelay && lowestBehind === 0) {
        logr.info(`Network nodes in tight agreement (range: ${lowestBehind}-${highestBehind}). Exiting sync mode at block ${currentBlockId}`)
        return true
    }
    
    return false
}

// Add a function to check if we're in post-sync transition period
const isInPostSyncPeriod = (timeWindow = 60000) => {
    if (!lastSyncExitTime) return false
    const timeSinceExit = new Date().getTime() - lastSyncExitTime
    return timeSinceExit < timeWindow
}

// Function to actually exit sync mode
const exitSyncMode = (blockId, steemBlockNum) => {
    if (!isSyncing) return false
    
    // Calculate consensus behind blocks for logging
    const behindBlocksCounts = [behindBlocks]
    
    // Collect behind blocks counts from connected peers
    for (const [nodeId, data] of networkSyncStatus.entries()) {
        if (typeof data.behindBlocks === 'number' && Date.now() - data.timestamp < 30000) {
            behindBlocksCounts.push(data.behindBlocks)
        }
    }
    
    // Calculate median behind blocks count as consensus
    let consensusBehind = behindBlocks
    if (behindBlocksCounts.length > 1) {
        behindBlocksCounts.sort((a, b) => a - b)
        const midIndex = Math.floor(behindBlocksCounts.length / 2)
        consensusBehind = behindBlocksCounts.length % 2 === 0
            ? Math.round((behindBlocksCounts[midIndex - 1] + behindBlocksCounts[midIndex]) / 2)
            : behindBlocksCounts[midIndex]
    }
    
    // Ensure we're completely exiting sync mode with immediate effect
    lastSyncExitTime = new Date().getTime()
    isSyncing = false
    exitCount++
    
    // Reset exit target
    syncExitTargetBlock = null
    
    // Track the current behind blocks for post-sync monitoring
    const currentBehind = behindBlocks
    
    // Reset post-sync tracking to start fresh
    if (chain && exitCount > 0) {
        chain.totalPostSyncBehind = 0;
        chain.postSyncBehindCount = 0;
        chain.avgPostSyncBehind = 0;
        logr.debug('Reset post-sync behind block tracking statistics for new measurements');
    }
    
    // Get the normal block time
    const normalBlockTime = config.blockTime
    
    // Broadcast our sync status change
    if (p2p && p2p.sockets && p2p.sockets.length > 0) {
        p2p.broadcastSyncStatus({
            behindBlocks: behindBlocks,
            steemBlock: steemBlockNum,
            isSyncing: false,
            blockId: blockId,
            consensusBlocks: consensusBehind,
            exitTarget: null
        })
    }

    logr.warn(`Exited sync mode at block ${blockId} (exit #${exitCount}), CONSENSUS: ${consensusBehind} blocks behind, current: ${currentBehind} blocks behind, switching to normal block time (${normalBlockTime}ms)`)
    logr.warn(`BEGIN POST-SYNC MONITORING: Tracking how far behind Steem the chain falls after sync exit`)
    return true
}

// Add a function to set readiness state
const setReadyToReceiveTransactions = (ready) => {
    if (ready !== readyToReceiveTransactions)
        logr.info('Steem transaction processing ' + (ready ? 'ENABLED' : 'DISABLED'))
    readyToReceiveTransactions = ready
}

const prefetchBlocks = async (blockNum) => {
    if (prefetchInProgress || circuitBreakerOpen) return

    prefetchInProgress = true
    let currentBlock = blockNum || config.steemStartBlock

    const latestSteemBlock = await getLatestSteemBlockNum()

    if (!latestSteemBlock) {
        prefetchInProgress = false
        logr.warn(`Could not fetch latest steem block`)
        return
    }
    // Determine how many blocks to prefetch based on sync status
    let blocksToPrefetch = PREFETCH_BLOCKS

    // Additional prefetching when we're very far behind
    const localBehindBlocks = latestSteemBlock - currentBlock

    if (localBehindBlocks > MAX_PREFETCH_BLOCKS) {
        blocksToPrefetch = MAX_PREFETCH_BLOCKS
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
    }
}

// Function declarations
const processBlock = async (blockNum) => {
    if (p2p.recovering) {
        logr.debug('Skipping Steem block processing - node not ready to receive transactions yet')
        return Promise.resolve()
    }

    if (processingBlocks.includes(blockNum)) {
        logr.warn(`Block ${blockNum} is already being processed`)
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
                    if (blockCache.size > PREFETCH_BLOCKS * 10) {
                        // Delete oldest entries (approximate LRU)
                        const keysToDelete = Array.from(blockCache.keys()).slice(0, PREFETCH_BLOCKS)
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
        console.log(transactions)
        // Update currentSteemBlock
        currentSteemBlock = Math.max(currentSteemBlock, blockNum)

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
                        isInWarmup: status.isInWarmup,
                        exitTarget: status.exitTarget
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

// Update the receivePeerSyncStatus function to track Steem heights and sync exit targets
const receivePeerSyncStatus = (nodeId, status) => {
    if (nodeId && status) {
        if (typeof status.behindBlocks === 'number') {
            networkSyncStatus.set(nodeId, {
                behindBlocks: status.behindBlocks,
                isSyncing: status.isSyncing,
                timestamp: Date.now(),
                blockId: status.blockId,
                consensusBlocks: status.consensusBlocks,
                isInWarmup: status.isInWarmup,
                exitTarget: status.exitTarget
            })
            
            // If node is reference node and sends an exit target, consider adopting it
            const networkStatus = getNetworkSyncStatus()
            if (nodeId === networkStatus.referenceNodeId && status.exitTarget && isSyncing && !syncExitTargetBlock) {
                syncExitTargetBlock = status.exitTarget
                logr.info(`Adopting sync exit target block ${syncExitTargetBlock} from reference node ${nodeId}`)
            }
        }
        if (typeof status.steemBlock === 'number') {
            networkSteemHeights.set(nodeId, {
                steemBlock: status.steemBlock,
                behindBlocks: status.behindBlocks,
                timestamp: Date.now(),
                blockId: status.blockId,
                consensusBlocks: status.consensusBlocks,
                isInWarmup: status.isInWarmup,
                exitTarget: status.exitTarget
            })
        }
    }
}

// Update the getSyncStatus function to include Steem block and exit target
const getSyncStatus = () => {
    // Return our current sync status for broadcasting to peers
    return {
        behindBlocks: behindBlocks,
        steemBlock: currentSteemBlock,
        isSyncing: isSyncing,
        exitTarget: syncExitTargetBlock
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
            // Exit only if reference node has exited recently (within last 60 seconds)
            const timeSinceReferenceExit = Date.now() - referenceStatus.timestamp
            if (timeSinceReferenceExit > 60000) {
                logr.debug(`Reference node sync status too old (${timeSinceReferenceExit}ms), staying in sync mode`)
                return false
            }
            
            // Make sure we're at the same block as reference node or very close
            const currentBlock = chain?.getLatestBlock()?._id || 0
            if (Math.abs(currentBlock - referenceStatus.blockId) > 3) {
                logr.debug(`We are at block ${currentBlock} but reference node exited at block ${referenceStatus.blockId}, staying in sync`)
                return false
            }
            
            logr.debug(`Following reference node ${networkStatus.referenceNodeId} to exit sync mode at block ${currentBlock}`)
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
    const currentBlock = chain?.getLatestBlock()?._id || 0

    logr.debug(`Reference node sync status check:
        - Nodes synced: ${syncedCount}/${totalNodes} (${syncedPercent.toFixed(1)}%)
        - Max behind: ${maxBehind}
        - Current block: ${currentSteemBlock}
        - Block ID: ${currentBlock}`)

    // As reference node, require stricter conditions
    const readyToExit = syncedPercent >= SYNC_EXIT_QUORUM_PERCENT &&
        maxBehind <= 1 && // Stricter: ensure nodes are fully caught up
        behindBlocks === 0;

    if (readyToExit) {
        logr.info(`As reference node, signaling network to exit sync mode at block ${currentBlock}`)
    }

    return readyToExit
}

module.exports = {
    init: (blockNum) => {
        nextSteemBlock = blockNum
        currentSteemBlock = blockNum

        // Clear existing intervals if any
        if (syncInterval) clearInterval(syncInterval)

        // Set initial state
        setReadyToReceiveTransactions(false)
        isSyncing = true
        syncExitTargetBlock = null // Reset sync exit target

        // First check network sync status
        checkNetworkSyncStatus().then(async () => {
            // Wait a bit to collect peer statuses
            await new Promise(resolve => setTimeout(resolve, 5000))

            // Get network's view of sync status
            const networkStatus = getNetworkSyncStatus()

            if (!p2p.recovering && networkStatus.referenceExists && networkStatus.referenceNodeId !== 'self') {
                // We have a reference node with higher blocks
                const referenceBlock = networkStatus.highestBlock
                logr.info(`Found reference node with higher block ${referenceBlock}, prioritizing network sync first`)

                // Start actively requesting blocks from peers
                let lastRequestedBlock = chain?.getLatestBlock()?._id || 0
                const requestBlocks = async () => {
                    const currentBlock = chain?.getLatestBlock()?._id || 0
                    const blocksBehind = referenceBlock - currentBlock

                    if (blocksBehind <= 5) {
                        logr.info('Network sync nearly complete, starting Steem sync')
                        clearInterval(waitForNetworkSync)
                        clearInterval(blockRequestInterval)
                        initSteemSync(blockNum)
                        return
                    }

                    // Request next batch of blocks if we haven't received previous ones
                    if (currentBlock === lastRequestedBlock) {
                        // Request a batch of blocks from peers
                        if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                            const batchSize = Math.min(10, blocksBehind) // Request up to 10 blocks at a time
                            for (let i = 0; i < batchSize; i++) {
                                const blockToRequest = currentBlock + i + 1
                                p2p.broadcast({
                                    t: 2, // QUERY_BLOCK message type
                                    d: blockToRequest
                                })
                            }
                            lastRequestedBlock = currentBlock + batchSize
                            logr.info(`Requested blocks ${currentBlock + 1} to ${lastRequestedBlock} from peers`)
                        }
                    }

                    logr.info(`Catching up with network, head block: ${currentBlock}, target: ${referenceBlock}, ${blocksBehind} blocks behind`)
                }

                // Set up intervals for status check and block requests
                const waitForNetworkSync = setInterval(requestBlocks, 3000)
                const blockRequestInterval = setInterval(requestBlocks, 1000)

                // Run first request immediately
                requestBlocks()
            } else {
                // No reference node or we are the reference, proceed with Steem sync
                initSteemSync(blockNum)
            }
        }).catch(err => {
            logr.error('Error checking network sync status:', err)
            // Fallback to direct Steem sync
            initSteemSync(blockNum)
        })
    },
    getCurrentBlock: () => {
        return currentSteemBlock
    },
    isInSyncMode,
    getBehindBlocks: () => {
        return behindBlocks
    },
    updateNetworkBehindBlocks,
    receivePeerSyncStatus,
    getSyncStatus: getSyncStatus,
    shouldExitSyncMode,
    getSyncExitTarget: () => syncExitTargetBlock,
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
    processBlock,
    fetchMissingBlock,
    prefetchBlocks,
    setReadyToReceiveTransactions,
    exitSyncMode,
    lastSyncExitTime,
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
    },
    getLatestSteemBlockNum,
    isInPostSyncPeriod
}

// Add new helper function for Steem sync initialization
const initSteemSync = (blockNum) => {
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


            // Initialize network sync status check
            lastNetworkSyncCheck = Date.now()
            // checkNetworkSyncStatus()
        }
    }).catch(err => {
        logr.error('Error initializing behind blocks count:', err)

    })



    logr.info('Steem subsystem initialized at block', blockNum)
}

