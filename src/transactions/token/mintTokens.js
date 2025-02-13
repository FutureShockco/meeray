module.exports = {
    fields: ['contractName', 'contractAction', 'contractPayload', 'timestamp', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        console.log('Validating mint tokens transaction:', tx)
        // Validate required fields
        if (!tx.data.contractPayload) {
            console.log('Missing contract payload')
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.contractPayload
        if (!payload.symbol || !payload.amount || !payload.to) {
            console.log('Missing required fields:', { symbol: payload.symbol, amount: payload.amount, to: payload.to })
            cb(false, 'missing required fields')
            return
        }

        // Validate amount
        const amount = parseFloat(payload.amount)
        if (isNaN(amount) || amount <= 0) {
            console.log('Invalid amount:', payload.amount)
            cb(false, 'invalid amount')
            return
        }

        // Validate recipient
        if (!validate.string(payload.to, config.accountMaxLength, config.accountMinLength)) {
            console.log('Invalid recipient:', payload.to)
            cb(false, 'invalid recipient')
            return
        }

        // Check if token exists and validate creator
        console.log('Looking for token:', payload.symbol)
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                console.error('Database error finding token:', err)
                cb(false, 'database error')
                return
            }
            if (!token) {
                console.log('Token does not exist:', payload.symbol)
                cb(false, 'token does not exist')
                return
            }
            if (token.creator !== tx.sender) {
                console.log('Invalid token creator. Expected:', token.creator, 'Got:', tx.sender)
                cb(false, 'only token creator can mint')
                return
            }

            // Check if minting would exceed maxSupply
            const currentSupply = parseFloat(token.currentSupply)
            const maxSupply = parseFloat(token.maxSupply)
            if (currentSupply + amount > maxSupply) {
                console.log('Mint would exceed max supply. Current:', currentSupply, 'Max:', maxSupply, 'Requested:', amount)
                cb(false, 'mint would exceed max supply')
                return
            }

            // Account existence check removed since accounts are created before transaction execution
            console.log('Mint token validation successful')
            cb(true)
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
                        if (!account.tokens) {
                            account.tokens = {}
                        }
                        if (!account.tokens[payload.symbol]) {
                            account.tokens[payload.symbol] = '0'
                        }

                        // Update recipient's token balance
                        const newBalance = (parseFloat(account.tokens[payload.symbol]) + amount).toString()
                        account.tokens[payload.symbol] = newBalance

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
