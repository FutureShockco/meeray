const dsteem = require('dsteem')
const client = new dsteem.Client([process.env.STEEM_API])

const transaction = require('./transaction.js')
const Transaction = require('./transactions')

let nextSteemBlock = config.steemStartBlock || 0
let currentSteemBlock = 0
let processingBlocks = []
let isSyncing = false
let syncInterval = null
let syncGracePeriod = false
let syncGraceTimeout = null
const MAX_CONSECUTIVE_ERRORS = 20
const MIN_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 15000
const CIRCUIT_BREAKER_THRESHOLD = 30
const CIRCUIT_BREAKER_RESET_TIMEOUT = 30000

let consecutiveErrors = 0
let retryDelay = MIN_RETRY_DELAY
let circuitBreakerOpen = false
let lastCircuitBreakerTrip = 0
let healthCheckFailures = 0

// Cache for prefetched blocks
let blockCache = new Map()
let prefetchInProgress = false

const prefetchBlocks = async (startBlock, count = 5) => {
    if (prefetchInProgress) return
    prefetchInProgress = true
    try {
        const promises = []
        const prefetchRange = []
        
        // Determine which blocks to prefetch
        for (let i = 0; i < count; i++) {
            const blockNum = startBlock + i
            if (!blockCache.has(blockNum) && !processingBlocks.includes(blockNum)) {
                prefetchRange.push(blockNum)
                promises.push(
                    client.database.getBlock(blockNum)
                        .then(block => {
                            if (block) {
                                blockCache.set(blockNum, block)
                                // Keep only recent blocks in cache
                                const maxCacheSize = 100
                                if (blockCache.size > maxCacheSize) {
                                    const oldestKey = Array.from(blockCache.keys())[0]
                                    blockCache.delete(oldestKey)
                                }
                            }
                            return block
                        })
                        .catch(err => {
                            logr.error(`Failed to prefetch block ${blockNum}: ${err.message}`)
                            return null
                        })
                )
            }
        }

        if (promises.length > 0) {
            await Promise.all(promises)
            logr.debug(`Prefetched ${promises.length} blocks starting from ${startBlock}`)
        }
    } catch (error) {
        logr.error('Error in prefetchBlocks:', error)
    } finally {
        prefetchInProgress = false
    }
}

// Function declarations
const processBlock = async (blockNum) => {
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
        prefetchBlocks(blockNum + 1)

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

// Update current Steem block
const updateSteemBlock = async () => {
    try {
        if (isCircuitBreakerOpen()) {
            return
        }

        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        if (!dynGlobalProps) {
            throw new Error('Failed to get dynamic global properties')
        }

        currentSteemBlock = dynGlobalProps.head_block_number
        resetErrorState()
        const newSyncState = (currentSteemBlock - nextSteemBlock) > 10

        if (newSyncState !== isSyncing) {
            isSyncing = newSyncState
            if (isSyncing) {
                // Entering sync mode
                logr.info(`Entering sync mode, ${currentSteemBlock - nextSteemBlock} blocks behind`)
                if (syncInterval) clearInterval(syncInterval)
                if (syncGraceTimeout) clearTimeout(syncGraceTimeout)
                syncGracePeriod = false
                syncInterval = setInterval(updateSteemBlock, 1000)
                processBlock(nextSteemBlock)
            } else {
                // Exiting sync mode
                logr.info('Exiting sync mode, caught up with Steem')
                if (syncInterval) clearInterval(syncInterval)

                // Set grace period
                syncGracePeriod = true
                if (syncGraceTimeout) clearTimeout(syncGraceTimeout)

                // After grace period, resume normal operation
                syncGraceTimeout = setTimeout(() => {
                    logr.info('Grace period ended, resuming normal operation')
                    syncGracePeriod = false
                    syncInterval = setInterval(updateSteemBlock, 3000)
                }, 5000) // 5 second grace period
            }
        }

        // During grace period, keep processing blocks but don't mine
        if (syncGracePeriod) {
            processBlock(nextSteemBlock)
        }
    } catch (err) {
        logr.error(`Error getting current Steem block: ${err.message}\nStack: ${err.stack}`)
        consecutiveErrors++

        if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
            circuitBreakerOpen = true
            lastCircuitBreakerTrip = Date.now()
            logr.error('Circuit breaker tripped due to too many consecutive errors')
            return
        }
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

const initPrefetch = () => {
    const startBlock = nextSteemBlock
    prefetchBlocks(startBlock)
}

module.exports = {
    init: (blockNum) => {
        nextSteemBlock = blockNum
        currentSteemBlock = blockNum
        isSyncing = false
    },
    getCurrentBlock: () => {
        return currentSteemBlock
    },
    isSyncing: () => {
        return isSyncing
    },
    isOnSteemBlock: (block) => {
        return new Promise((resolve, reject) => {
            const steemBlock = blockCache.get(block.steemblock)
            if (!steemBlock) {
                resolve(false)
                return
            }

            // Check each transaction in our block against Steem block
            for (let tx of block.txs) {
                if (tx.type !== 'custom_json')
                    continue

                // Find matching custom_json operation in Steem block
                let found = false
                for (let steemTx of steemBlock.transactions) {
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
                }

                if (!found) {
                    logr.debug('Transaction not found in Steem block:', {
                        blockNum: block.steemblock,
                        tx: {
                            contract: tx.data.contract
                        }
                    })
                    resolve(false)
                    return
                }
            }
            resolve(true)

        })
    },
    processBlock: processBlock,
    initPrefetch
}
