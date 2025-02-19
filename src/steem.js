const config = require('./config.js')
const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.justyy.com')
const chain = require('./chain.js')
const cache = require('./cache.js')
const transaction = require('./transaction.js')
const Transaction = require('./transactions')

let nextSteemBlock = 0
let lastVerifiedBlock = 0
let currentSteemBlock = 0
let processing = false
let processingBlocks = []
let isSyncing = false
let syncInterval = null
const MAX_CONSECUTIVE_ERRORS = 10
const MIN_RETRY_DELAY = 3000
const MAX_RETRY_DELAY = 30000
const CIRCUIT_BREAKER_THRESHOLD = 15
const CIRCUIT_BREAKER_RESET_TIMEOUT = 60000

let consecutiveErrors = 0
let retryDelay = MIN_RETRY_DELAY
let circuitBreakerOpen = false
let lastCircuitBreakerTrip = 0
let healthCheckFailures = 0

// Cache for prefetched blocks
let blockCache = new Map()
let prefetchInProgress = false

const prefetchBlocks = async (startBlock, count = 2) => {
    if (prefetchInProgress) return
    prefetchInProgress = true
    
    try {
        const promises = []
        for (let i = 0; i < count; i++) {
            const blockNum = startBlock + i
            if (!blockCache.has(blockNum)) {
                promises.push(
                    client.database.getBlock(blockNum)
                        .then(block => {
                            if (block) blockCache.set(blockNum, block)
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
        }
    } catch (error) {
        logr.error('Error in prefetchBlocks:', error)
    } finally {
        prefetchInProgress = false
    }
}

// Function declarations
const processBlock = async (blockNum) => {
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
            // If not in cache, fetch directly
            steemBlock = await client.database.getBlock(blockNum)
        } else {
            // Remove from cache if we used it
            blockCache.delete(blockNum)
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
            const [opType, opData] = op

            if (opType !== 'custom_json' || opData.id !== 'sidechain') {
                opIndex++
                continue
            }

            try {
                const json = JSON.parse(opData.json)
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

                validationPromises.push(
                    new Promise((resolve) => {
                        transaction.isValid(newTx, new Date(steemBlock.timestamp + 'Z').getTime(), (isValid, error) => {
                            if (isValid) {
                                txs.push(newTx)
                            } else {
                                console.log(error)
                            }
                            resolve()
                        })
                    })
                )
            } catch (err) {
                logr.warn('Error processing Steem transaction', err)
            }
            opIndex++
        }
    }

    // Wait for all validations to complete
    await Promise.all(validationPromises)
    return txs
}

// Update current Steem block
const updateSteemBlock = async () => {
    // Check circuit breaker
    if (isCircuitBreakerOpen()) {
        logr.warn('Circuit breaker is open, skipping block update')
        return
    }

    try {
        // Perform health check
        if (healthCheckFailures > 0 && !await checkApiHealth()) {
            logr.warn('Skipping block update due to failed health check')
            return
        }

        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
            .catch(err => {
                logr.error(`Failed to get dynamic global properties: ${err.message}\nStack: ${err.stack}`)
                return null
            })

        if (!dynGlobalProps) {
            consecutiveErrors++
            
            if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitBreakerOpen = true
                lastCircuitBreakerTrip = Date.now()
                logr.error('Circuit breaker tripped due to too many consecutive errors')
                return
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                const delay = calculateRetryDelay()
                logr.warn(`Too many consecutive errors, waiting ${delay}ms before retrying...`)
                await new Promise(resolve => setTimeout(resolve, delay))
            }
            return
        }

        currentSteemBlock = dynGlobalProps.head_block_number
        resetErrorState()

        const newSyncState = (currentSteemBlock - nextSteemBlock) > 5
        
        if (newSyncState !== isSyncing) {
            isSyncing = newSyncState
            if (isSyncing) {
                logr.info(`Entering sync mode, ${currentSteemBlock - nextSteemBlock} blocks behind`)
                if (syncInterval) clearInterval(syncInterval)
                syncInterval = setInterval(updateSteemBlock, 1000)
                processBlock(nextSteemBlock)
            } else {
                logr.info('Exiting sync mode, caught up with Steem')
                if (syncInterval) clearInterval(syncInterval)
                syncInterval = setInterval(updateSteemBlock, 3000)
            }
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

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            const delay = calculateRetryDelay()
            logr.warn(`Too many consecutive errors, waiting ${delay}ms before retrying...`)
            await new Promise(resolve => setTimeout(resolve, delay))
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
    
    // Check if enough time has passed to try resetting the circuit breaker
    if (Date.now() - lastCircuitBreakerTrip >= CIRCUIT_BREAKER_RESET_TIMEOUT) {
        circuitBreakerOpen = false
        logr.info('Circuit breaker reset after timeout period')
        return false
    }
    
    return true
}

// Exponential backoff calculation
const calculateRetryDelay = () => {
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
    return retryDelay
}

// Reset error handling state
const resetErrorState = () => {
    consecutiveErrors = 0
    retryDelay = MIN_RETRY_DELAY
    healthCheckFailures = 0
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
            client.database.getBlockHeader(block.steemblock)
                .then((steemBlock) => {
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
                .catch((err) => {
                    resolve(false)
                })
        })
    },
    processBlock: processBlock,
    initPrefetch
}
