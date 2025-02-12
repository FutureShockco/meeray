const config = require('../config')
const cache = require('../cache')
const validate = require('../validate')

module.exports = {
    fields: ['contractName', 'contractAction', 'contractPayload', 'steemTxId', 'timestamp', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        // Validate required fields
        if (!tx.data.contractPayload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.contractPayload
        if (!payload.symbol || !payload.amount || !payload.to) {
            cb(false, 'missing required fields')
            return
        }

        // Validate amount
        const amount = parseFloat(payload.amount)
        if (isNaN(amount) || amount <= 0) {
            cb(false, 'invalid amount')
            return
        }

        // Check if token exists
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!token) {
                cb(false, 'token does not exist')
                return
            }

            // Check if sender has enough balance
            cache.findOne('accounts', {name: tx.sender}, function(err, account) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (!account) {
                    cb(false, 'sender account does not exist')
                    return
                }

                const balance = account.tokenBalances?.[payload.symbol] || '0'
                if (parseFloat(balance) < amount) {
                    cb(false, 'insufficient balance')
                    return
                }
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.contractPayload
        const amount = parseFloat(payload.amount)

        // Get sender account
        cache.findOne('accounts', {name: tx.sender}, function(err, senderAccount) {
            if (err) {
                cb(false, 'error getting sender account')
                return
            }

            // Initialize sender token balance if needed
            if (!senderAccount.tokenBalances) {
                senderAccount.tokenBalances = {}
            }
            if (!senderAccount.tokenBalances[payload.symbol]) {
                senderAccount.tokenBalances[payload.symbol] = '0'
            }

            // Update sender balance
            const newSenderBalance = (parseFloat(senderAccount.tokenBalances[payload.symbol]) - amount).toString()
            senderAccount.tokenBalances[payload.symbol] = newSenderBalance

            // Save sender account
            cache.updateOne('accounts',
                {name: tx.sender},
                {$set: {tokenBalances: senderAccount.tokenBalances}},
                function(err) {
                    if (err) {
                        cb(false, 'error updating sender balance')
                        return
                    }

                    // Get recipient account
                    cache.findOne('accounts', {name: payload.to}, function(err, recipientAccount) {
                        if (err) {
                            cb(false, 'error getting recipient account')
                            return
                        }

                        // Initialize recipient token balance if needed
                        if (!recipientAccount.tokenBalances) {
                            recipientAccount.tokenBalances = {}
                        }
                        if (!recipientAccount.tokenBalances[payload.symbol]) {
                            recipientAccount.tokenBalances[payload.symbol] = '0'
                        }

                        // Update recipient balance
                        const newRecipientBalance = (parseFloat(recipientAccount.tokenBalances[payload.symbol]) + amount).toString()
                        recipientAccount.tokenBalances[payload.symbol] = newRecipientBalance

                        // Save recipient account
                        cache.updateOne('accounts',
                            {name: payload.to},
                            {$set: {tokenBalances: recipientAccount.tokenBalances}},
                            function(err) {
                                if (err) {
                                    cb(false, 'error updating recipient balance')
                                    return
                                }
                                cb(true)
                            }
                        )
                    })
                }
            )
        })
    }
}
