module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        // Validate required fields
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }       

        const payload = tx.data.payload
        if (!payload.symbol || !payload.amount || !payload.to) {
            cb(false, 'missing required fields', { symbol: payload.symbol, amount: payload.amount, to: payload.to })
            return
        }

        // Validate amount
        if (!validate.integer(payload.amount, false, false)) {
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
            if (token.currentSupply + parseInt(payload.amount) > token.maxSupply) {
                cb(false, 'mint would exceed max supply')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        const amount = parseInt(payload.amount)

        // First get the token to get current supply
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                cb(false, 'error getting token')
                return
            }

            // Update token supply
            cache.updateOne('tokens', 
                {symbol: payload.symbol},
                {$inc: {currentSupply: amount}},
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
                        if (!account.tokens) {
                            account.tokens = {}
                        }
                        if (!account.tokens[payload.symbol]) {
                            account.tokens[payload.symbol] = 0
                        }

                        // Update recipient's token balance
                        account.tokens[payload.symbol] += amount

                        // Save updated account
                        cache.updateOne('accounts',
                            {name: payload.to},
                            {$set: {tokens: account.tokens}},
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
