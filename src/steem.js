const dsteem = require('dsteem')
const client = new dsteem.Client([process.env.STEEM_API])

const transaction = require('./transaction.js')
const Transaction = require('./transactions')

let nextSteemBlock = config.steemStartBlock || 0
let currentSteemBlock = 0
let processingBlocks = []
let isSyncing = false
let forceSyncUntilBlock = 0  // Force sync mode until this block height
let syncInterval = null
let syncGracePeriod = false
let syncGraceTimeout = null
let behindBlocks = 0
const MAX_CONSECUTIVE_ERRORS = 20
const MIN_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 15000
const CIRCUIT_BREAKER_THRESHOLD = 30
const CIRCUIT_BREAKER_RESET_TIMEOUT = 30000
const MAX_PREFETCH_BLOCKS = 10  // Maximum number of blocks to prefetch at once
const SYNC_THRESHOLD = 5  // Number of blocks behind before entering sync mode
const SYNC_EXIT_THRESHOLD = 2  // Number of blocks behind before exiting sync mode
const SYNC_FORCE_BLOCKS = 20   // Number of blocks to stay in sync mode after catching up

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

// Add a function to set readiness state
const setReadyToReceiveTransactions = (ready) => {
    readyToReceiveTransactions = ready
    logr.info('Steem transaction processing ' + (ready ? 'ENABLED' : 'DISABLED'))
}

const prefetchBlocks = async () => {
    if (prefetchInProgress || circuitBreakerOpen) return

    prefetchInProgress = true
    const currentBlock = nextSteemBlock
    const latestSteemBlock = await getLatestSteemBlockNum()
    
    if (latestSteemBlock && currentBlock <= latestSteemBlock) {
        try {
            // Determine how many blocks to prefetch (prefetch more in sync mode)
            const prefetchCount = isSyncing 
                ? Math.min(MAX_PREFETCH_BLOCKS * 2, latestSteemBlock - currentBlock + 1)
                : Math.min(MAX_PREFETCH_BLOCKS, latestSteemBlock - currentBlock + 1);
            
            if (prefetchCount > 0) {
                logr.debug(`Prefetching ${prefetchCount} Steem blocks starting from ${currentBlock}, sync mode: ${isSyncing}`);
                
                // Track successful prefetches
                let successCount = 0;
                
                // Prefetch blocks one by one
                for (let i = 0; i < prefetchCount; i++) {
                    const blockNum = currentBlock + i
                    
                    // Skip if already being processed
                    if (processingBlocks.includes(blockNum)) {
                        logr.debug(`Block ${blockNum} is already being processed, skipping prefetch`)
                        continue
                    }
                    
                    // Skip if already in cache
                    if (blockCache.get(blockNum)) {
                        logr.debug(`Block ${blockNum} already in cache, skipping prefetch`)
                        successCount++;
                        continue
                    }
                    
                    try {
                        // Process the block to cache it
                        await processBlock(blockNum)
                        successCount++;
                    } catch (err) {
                        logr.error(`Error prefetching block ${blockNum}:`, err);
                        // Continue with next block
                    }
                }
                
                logr.debug(`Prefetched ${successCount}/${prefetchCount} blocks successfully`);
                
                // Update currentSteemBlock if we've successfully cached blocks
                if (successCount > 0) {
                    currentSteemBlock = Math.max(currentSteemBlock, currentBlock + successCount - 1);
                }
            }
        } catch (error) {
            logr.error('Error prefetching blocks:', error)
        }
    }
    
    prefetchInProgress = false
}

// Function declarations
const processBlock = async (blockNum) => {
    if (!readyToReceiveTransactions && !isSyncing()) {
        logr.debug('Skipping Steem block processing - node not ready to receive transactions yet')
        return Promise.resolve()
    }
    
    if (processingBlocks.includes(blockNum)) {
        logr.debug(`Block ${blockNum} is already being processed`)
        return blockNum
    }
    
    processingBlocks.push(blockNum)

    try {
        // Check circuit breaker
        if (isCircuitBreakerOpen()) {
            logr.warn('Circuit breaker is open, skipping block processing')
            processingBlocks = processingBlocks.filter(b => b !== blockNum)
            return blockNum
        }

        // Start prefetching next blocks while we process current one
        prefetchBlocks()

        // Try to get block from cache first
        let steemBlock = blockCache.get(blockNum)
        if (!steemBlock) {
            // If not in cache, fetch directly with retry
            let retries = 3
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
        }

        if (!steemBlock) {
            processingBlocks = processingBlocks.filter(b => b !== blockNum)
            consecutiveErrors++

            if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitBreakerOpen = true
                lastCircuitBreakerTrip = Date.now()
                logr.error('Circuit breaker tripped due to too many consecutive errors')
                return blockNum
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                const delay = calculateRetryDelay()
                logr.warn(`Too many consecutive errors, waiting ${delay}ms before retrying...`)
                await new Promise(resolve => setTimeout(resolve, delay))
            }
            return blockNum
        }

        // Cache the block for future reference
        blockCache.set(blockNum, steemBlock)
        
        const txs = await processTransactions(steemBlock, blockNum)
        if (txs.length > 0) {
            transaction.addToPool(txs)
        }

        processingBlocks = processingBlocks.filter(b => b !== blockNum)
        nextSteemBlock = blockNum + 1
        resetErrorState()

        return blockNum

    } catch (error) {
        logr.error(`Error processing block ${blockNum}:`, error)
        logr.error(`Stack trace: ${error.stack}`)
        processingBlocks = processingBlocks.filter(b => b !== blockNum)
        consecutiveErrors++

        if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
            circuitBreakerOpen = true
            lastCircuitBreakerTrip = Date.now()
            logr.error('Circuit breaker tripped due to too many consecutive errors')
            return blockNum
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            const delay = calculateRetryDelay()
            logr.warn(`Too many consecutive errors, waiting ${delay}ms before retrying...`)
            await new Promise(resolve => setTimeout(resolve, delay))
        }
        return blockNum
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
        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        const latestSteemBlock = dynGlobalProps.head_block_number
        const localBehindBlocks = latestSteemBlock - currentSteemBlock
        
        // Only update the network-wide behind blocks if our count is higher
        // This ensures the network always knows the furthest behind node
        if (localBehindBlocks > behindBlocks) {
            behindBlocks = localBehindBlocks
            // Broadcast to network in next message if we're significantly behind
            if (p2p && p2p.broadcast && localBehindBlocks > SYNC_THRESHOLD * 1.5) {
                p2p.broadcast({
                    t: 'STEEM_BEHIND',
                    d: behindBlocks
                })
            }
        }

        // Don't change sync mode if we're in forced sync by the network
        if (chain && chain.getLatestBlock() && chain.getLatestBlock()._id < forceSyncUntilBlock) {
            return latestSteemBlock
        }

        // Determine if we should be in sync mode
        if (behindBlocks >= SYNC_THRESHOLD) {
            if (!isSyncing) {
                logr.info(`Entering sync mode, ${behindBlocks} blocks behind`)
                isSyncing = true
                
                // If we fall significantly behind, notify other nodes by embedding in next block
                if (behindBlocks >= SYNC_THRESHOLD * 2 && chain && process.env.NODE_OWNER) {
                    // This node will be in sync mode for a while, so when it mines a block,
                    // the network should also enter sync mode to stay coordinated
                    forceSyncUntilBlock = chain.getLatestBlock()._id + SYNC_FORCE_BLOCKS
                }
            }
        } else if (behindBlocks <= SYNC_EXIT_THRESHOLD) {
            if (isSyncing && forceSyncUntilBlock === 0) {
                logr.info('Exiting sync mode, caught up with Steem blockchain')
                isSyncing = false
            }
        }

        // In sync mode, prefetch more aggressively
        if (isSyncing && !prefetchInProgress) {
            prefetchBlocks()
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

module.exports = {
    init: (blockNum) => {
        nextSteemBlock = blockNum
        currentSteemBlock = blockNum
        
        // Clear existing intervals if any
        if (syncInterval) clearInterval(syncInterval)
        
        // Set up regular state updates
        syncInterval = setInterval(updateSteemBlock, 3000)
        
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
                
                // Force sync mode for all nodes for a while
                if (chain && chain.getLatestBlock()) {
                    forceSyncUntilBlock = chain.getLatestBlock()._id + SYNC_FORCE_BLOCKS
                }
            }
        }
    },
    setSyncMode: (blockHeight) => {
        // Force sync mode for the next SYNC_FORCE_BLOCKS blocks
        if (blockHeight > 0) {
            forceSyncUntilBlock = blockHeight + SYNC_FORCE_BLOCKS
            if (!isSyncing) {
                isSyncing = true
                logr.info(`Network-enforced sync mode enabled until block ${forceSyncUntilBlock}`)
            }
        } else if (forceSyncUntilBlock > 0) {
            // Exit forced sync mode
            forceSyncUntilBlock = 0
            if (behindBlocks <= SYNC_EXIT_THRESHOLD) {
                isSyncing = false
                logr.info('Network-enforced sync mode disabled')
            }
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
    setReadyToReceiveTransactions
}
