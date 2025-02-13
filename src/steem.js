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
                                if (!json.contractName || !json.contractAction || !json.contractPayload)
                                    continue

                                let txType
                                const contractType = json.contractAction + json.contractName
                                switch (contractType.toLowerCase()) {
                                    case 'minttokens':
                                        txType = Transaction.Types.MINT_TOKENS
                                        break
                                    case 'createtokens':
                                        txType = Transaction.Types.CREATE_TOKENS
                                        break
                                    case 'transfertokens':
                                        txType = Transaction.Types.TRANSFER_TOKENS
                                        break
                                    case 'createNft':
                                        txType = Transaction.Types.CREATE_NFT_COLLECTION
                                        break
                                    case 'mintNft':
                                        txType = Transaction.Types.MINT_NFT
                                        break
                                    case 'transferNft':
                                        txType = Transaction.Types.TRANSFER_NFT
                                        break
                                    case 'createMarket':
                                        txType = Transaction.Types.CREATE_MARKET
                                        break
                                    case 'placeOrder':
                                        txType = Transaction.Types.PLACE_ORDER
                                        break
                                    case 'createStakingPool':
                                        txType = Transaction.Types.CREATE_STAKING_POOL
                                        break
                                    case 'stakeTokens':
                                        txType = Transaction.Types.STAKE_TOKENS
                                        break
                                    case 'unstakeTokens':
                                        txType = Transaction.Types.UNSTAKE_TOKENS
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
                                    sender: opData.required_posting_auths[0] || opData.required_auths[0],
                                    ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                                    ref: blockNum + ':' + tx.operations.indexOf(op)
                                }

                                validationPromises.push(new Promise((resolveValidation) => {
                                    transaction.isValid(newTx, new Date(steemBlock.timestamp + 'Z').getTime(), (isValid, error) => {
                                        if (isValid) {
                                            transaction.addToPool([newTx])
                                        }
                                        console.log(error)
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
