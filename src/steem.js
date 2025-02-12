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
            client.database.getBlock(block.steemblock)
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
                                        contractName: tx.data.contractName,
                                        contractAction: tx.data.contractAction,
                                        contractPayload: tx.data.contractPayload
                                    })) {
                                    found = true
                                    break
                                }
                            }
                            if (found) break
                        }

                        if (!found) {
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
                            if (op[0] !== 'custom_json' || op[1].id !== 'sidechain')
                                continue

                            try {
                                const json = JSON.parse(op[1].json)
                                if (!json.contractName || !json.contractAction || !json.contractPayload)
                                    continue

                                let txType
                                const contractType = json.contractAction + json.contractName
                                switch (contractType.toLowerCase()) {
                                    case 'createtokens':
                                        txType = Transaction.Types.CREATE_TOKENS
                                        break
                                    case 'minttokens':
                                        txType = Transaction.Types.MINT_TOKENS
                                        break
                                    case 'transfertokens':
                                        txType = Transaction.Types.TRANSFER_TOKENS
                                        break
                                    default:
                                        const typeNum = parseInt(json.contractAction)
                                        if (!isNaN(typeNum) && Transaction.transactions[typeNum]) {
                                            txType = typeNum
                                        } else {
                                            continue
                                        }
                                }

                                const newTx = {
                                    type: txType,
                                    data: json,
                                    sender: op[1].required_posting_auths[0] || op[1].required_auths[0],
                                    ts: new Date(steemBlock.timestamp + 'Z').getTime()
                                }

                                validationPromises.push(new Promise((resolveValidation) => {
                                    transaction.isValid(newTx, new Date(steemBlock.timestamp + 'Z').getTime(), (isValid, error) => {
                                        if (isValid) {
                                            transaction.addToPool([newTx])
                                        }
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
