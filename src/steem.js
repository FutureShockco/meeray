const config = require('./config.js')
const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.steemit.com')
const chain = require('./chain.js')
const cache = require('./cache.js')
const transaction = require('./transaction.js')
const Transaction = require('./transactions')

let nextSteemBlock = 0
let lastVerifiedBlock = 0
let processing = false
let processingBlocks = []

module.exports = {
    init: (blockNum) => {
        nextSteemBlock = blockNum
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
    processBlock: (blockNum) => {
        return new Promise((resolve, reject) => {
            if (processing) {
                resolve()
                return
            }
            processing = true
            processingBlocks = processingBlocks.filter(b => b !== blockNum)

            client.database.getBlock(blockNum)
                .then((steemBlock) => {
                    if (!steemBlock) {
                        processing = false
                        resolve()
                        return
                    }

                    const validationPromises = []
                    // Process each transaction
                    for (let tx of steemBlock.transactions) {
                        for (let op of tx.operations) {
                            const [opType, opData] = op

                            if (opType !== 'custom_json' || opData.id !== 'sidechain')
                                continue

                            try {
                                const json = JSON.parse(opData.json)
                                if (!json.contract || !json.payload)
                                    continue

                                let txType
                                switch (json.contract.toLowerCase()) {
                                    case 'enablenode':
                                        txType = Transaction.Types.ENABLE_NODE
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
                                        payload: json.payload
                                    },
                                    sender: opData.required_posting_auths[0] || opData.required_auths[0],
                                    ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                                    ref: blockNum + ':' + tx.operations.indexOf(op)
                                }

                                validationPromises.push(new Promise((resolveValidation) => {
                                    transaction.isValid(newTx, new Date(steemBlock.timestamp + 'Z').getTime(), (isValid, error) => {
                                        if (isValid) {
                                            transaction.addToPool([newTx])
                                        }
                                        else console.log(error)
                                        resolveValidation()
                                    })
                                }))
                            } catch (err) {
                                logr.warn('Error processing Steem transaction', err)
                            }
                        }
                    }

                    // Wait for all validations to complete
                    Promise.all(validationPromises)
                        .then(() => {
                            lastVerifiedBlock = blockNum
                            processing = false
                            resolve()
                        })
                        .catch(() => {
                            processing = false
                            resolve()
                        })
                })
                .catch((err) => {
                    processing = false
                    reject(err)
                })
        })
    }
}
