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

        // Validate recipient
        if (!validate.string(payload.to, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid recipient')
            return
        }

        // Check if token exists and validate creator
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!token) {
                cb(false, 'token does not exist')
                return
            }
            if (token.creator !== tx.sender) {
                cb(false, 'only token creator can mint')
                return
            }

            // Check if minting would exceed maxSupply
            const currentSupply = parseFloat(token.currentSupply)
            const maxSupply = parseFloat(token.maxSupply)
            if (currentSupply + amount > maxSupply) {
                cb(false, 'mint would exceed max supply')
                return
            }

            // Check if recipient account exists
            cache.findOne('accounts', {name: payload.to}, function(err, account) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (!account) {
                    cb(false, 'recipient account does not exist')
                    return
                }
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.contractPayload
        const amount = parseFloat(payload.amount)

        // First get the token to get current supply
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                cb(false, 'error getting token')
                return
            }

            // Update token supply
            cache.updateOne('tokens', 
                {symbol: payload.symbol},
                {$set: {currentSupply: (parseFloat(token.currentSupply) + amount).toString()}},
                function(err) {
                    if (err) {
                        cb(false, 'error updating token supply')
                        return
                    }

                    // Get recipient account
                    cache.findOne('accounts', {name: payload.to}, function(err, account) {
                        if (err) {
                            cb(false, 'error getting recipient account')
                            return
                        }

                        // Initialize token balance if it doesn't exist
                        if (!account.tokenBalances) {
                            account.tokenBalances = {}
                        }
                        if (!account.tokenBalances[payload.symbol]) {
                            account.tokenBalances[payload.symbol] = '0'
                        }

                        // Update recipient's token balance
                        const newBalance = (parseFloat(account.tokenBalances[payload.symbol]) + amount).toString()
                        account.tokenBalances[payload.symbol] = newBalance

                        // Save updated account
                        cache.updateOne('accounts',
                            {name: payload.to},
                            {$set: {tokenBalances: account.tokenBalances}},
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
