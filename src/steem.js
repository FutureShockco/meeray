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
                                    default:
                                        const typeNum = parseInt(json.contractAction)
                                        if (!isNaN(typeNum) && Transaction.transactions[typeNum]) {
                                            txType = typeNum
                                        } else {
                                            continue
                                        }
                                }
                                console.log(txType)

                                // Create accounts if needed (returns a promise)
                                const createAccountsIfNeeded = new Promise((resolveAccounts) => {
                                    const sender = opData.required_posting_auths[0] || opData.required_auths[0]
                                    console.log('Checking sender account:', sender)
                                    
                                    // First check/create sender account
                                    cache.findOne('accounts', { name: sender }, function (err, account) {
                                        if (err) throw err
                                        console.log('Sender account exists?', !!account)
                                        if (!account) {
                                            console.log('Creating sender account:', sender)
                                            // Create sender account and write to disk immediately
                                            const senderDoc = {
                                                name: sender.toLowerCase(),
                                                balance: 0,
                                                created: {
                                                    ts: new Date(steemBlock.timestamp + 'Z').getTime()
                                                }
                                            }
                                            db.collection('accounts').insertOne(senderDoc, function(err) {
                                                if (err) throw err
                                                console.log('Sender account created and written to disk')
                                                cache.copy.accounts[sender.toLowerCase()] = senderDoc
                                                
                                                // After sender account, check/create recipient account if needed
                                                if (json.contractPayload && json.contractPayload.to) {
                                                    const recipient = json.contractPayload.to
                                                    console.log('Checking recipient account:', recipient)
                                                    cache.findOne('accounts', { name: recipient }, function (err, account) {
                                                        if (err) throw err
                                                        console.log('Recipient account exists?', !!account)
                                                        if (!account) {
                                                            console.log('Creating recipient account:', recipient)
                                                            // Create recipient account and write to disk immediately
                                                            const recipientDoc = {
                                                                name: recipient.toLowerCase(),
                                                                balance: 0,
                                                                created: {
                                                                    ts: new Date(steemBlock.timestamp + 'Z').getTime()
                                                                }
                                                            }
                                                            db.collection('accounts').insertOne(recipientDoc, function(err) {
                                                                if (err) throw err
                                                                console.log('Recipient account created and written to disk')
                                                                cache.copy.accounts[recipient.toLowerCase()] = recipientDoc
                                                                resolveAccounts()
                                                            })
                                                        } else {
                                                            resolveAccounts()
                                                        }
                                                    })
                                                } else {
                                                    resolveAccounts()
                                                }
                                            })
                                        } else {
                                            // Check recipient if needed
                                            if (json.contractPayload && json.contractPayload.to) {
                                                const recipient = json.contractPayload.to
                                                console.log('Checking recipient account:', recipient)
                                                cache.findOne('accounts', { name: recipient }, function (err, account) {
                                                    if (err) throw err
                                                    console.log('Recipient account exists?', !!account)
                                                    if (!account) {
                                                        console.log('Creating recipient account:', recipient)
                                                        // Create recipient account and write to disk immediately
                                                        const recipientDoc = {
                                                            name: recipient.toLowerCase(),
                                                            balance: 0,
                                                            created: {
                                                                ts: new Date(steemBlock.timestamp + 'Z').getTime()
                                                            }
                                                        }
                                                        db.collection('accounts').insertOne(recipientDoc, function(err) {
                                                            if (err) throw err
                                                            console.log('Recipient account created and written to disk')
                                                            cache.copy.accounts[recipient.toLowerCase()] = recipientDoc
                                                            resolveAccounts()
                                                        })
                                                    } else {
                                                        resolveAccounts()
                                                    }
                                                })
                                            } else {
                                                resolveAccounts()
                                            }
                                        }
                                    })
                                })

                                // Add validation promise that waits for account creation
                                validationPromises.push(new Promise((resolveValidation) => {
                                    console.log('Waiting for account creation to complete...')
                                    createAccountsIfNeeded.then(() => {
                                        console.log('Account creation completed, proceeding with transaction')
                                        const newTx = {
                                            type: txType,
                                            data: json,
                                            sender: opData.required_posting_auths[0] || opData.required_auths[0],
                                            ts: new Date(steemBlock.timestamp + 'Z').getTime(),
                                            ref: blockNum + ':' + tx.operations.indexOf(op)
                                        }

                                        transaction.isValid(newTx, new Date(steemBlock.timestamp + 'Z').getTime(), (isValid, error) => {
                                            if (isValid) {
                                                transaction.addToPool([newTx])
                                            }
                                            console.log(error)
                                            resolveValidation()
                                        })
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
