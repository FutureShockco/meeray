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

// Function declarations
const processBlock = async (blockNum) => {
    if (processingBlocks.includes(blockNum)) return
    processingBlocks.push(blockNum)
    
    try {
        // During sync, process multiple blocks in parallel
        if (isSyncing && !processing) {
            processing = true
            const batchSize = 10 // Process more blocks at once during sync
            const promises = []
            
            for (let i = 0; i < batchSize && nextSteemBlock + i <= currentSteemBlock; i++) {
                const nextBlock = nextSteemBlock + i
                if (!processingBlocks.includes(nextBlock)) {
                    processingBlocks.push(nextBlock)
                    promises.push(client.database.getBlock(nextBlock))
                }
            }
            
            if (promises.length > 0) {
                const blocks = await Promise.all(promises)
                for (let i = 0; i < blocks.length; i++) {
                    const steemBlock = blocks[i]
                    if (steemBlock) {
                        const txs = await processTransactions(steemBlock, nextSteemBlock + i)
                        if (txs.length > 0) {
                            transaction.addToPool(txs)
                        }
                    }
                    processingBlocks = processingBlocks.filter(b => b !== nextSteemBlock + i)
                    nextSteemBlock = nextSteemBlock + i + 1
                }
            }
            
            processing = false
            return
        }

        const steemBlock = await client.database.getBlock(blockNum)
        if (!steemBlock) {
            processingBlocks = processingBlocks.filter(b => b !== blockNum)
            return
        }

        const txs = await processTransactions(steemBlock, blockNum)
        if (txs.length > 0) {
            transaction.addToPool(txs)
        }
        
        processingBlocks = processingBlocks.filter(b => b !== blockNum)
        nextSteemBlock = blockNum + 1
    } catch (error) {
        logr.error('Error processing block:', error)
        processingBlocks = processingBlocks.filter(b => b !== blockNum)
    }
}

// Helper function to process transactions from a Steem block
const processTransactions = async (steemBlock, blockNum) => {
    const txs = []
    const validationPromises = []

    // Process each transaction
    for (let tx of steemBlock.transactions) {
        for (let op of tx.operations) {
            const [opType, opData] = op

            if (opType !== 'custom_json' || opData.id !== 'sidechain')
                continue

            try {
                const json = JSON.parse(opData.json)
                if (!json.contract || !json.contractPayload)
                    continue

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
                    ref: blockNum + ':' + tx.operations.indexOf(op)
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
        }
    }

    // Wait for all validations to complete
    await Promise.all(validationPromises)
    return txs
}

// Update current Steem block
const updateSteemBlock = async () => {
    try {
        const dynGlobalProps = await client.database.getDynamicGlobalProperties()
        currentSteemBlock = dynGlobalProps.head_block_number
        // Check if we're more than 5 blocks behind (more aggressive sync)
        const newSyncState = (currentSteemBlock - nextSteemBlock) > 5
        
        // If sync state changed, adjust check frequency
        if (newSyncState !== isSyncing) {
            isSyncing = newSyncState
            if (isSyncing) {
                logr.info('Entering sync mode, '+(currentSteemBlock - nextSteemBlock)+' blocks behind')
                // Check more frequently during sync
                if (syncInterval) clearInterval(syncInterval)
                syncInterval = setInterval(updateSteemBlock, 1000)
                // Trigger immediate block processing
                processBlock(nextSteemBlock)
            } else {
                logr.info('Exiting sync mode, caught up with Steem')
                // Normal operation frequency
                if (syncInterval) clearInterval(syncInterval)
                syncInterval = setInterval(updateSteemBlock, 3000)
            }
        }
    } catch (err) {
        logr.error('Error getting current Steem block:', err)
    }
}

// Initial interval
syncInterval = setInterval(updateSteemBlock, 3000)

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
    processBlock: processBlock
}
