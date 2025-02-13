module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        const payload = tx.data.payload
        if (!payload.symbol || !payload.amount || !payload.recipient) {
            cb(false, 'missing required fields')
            return
        }

        // Validate amount
        if (!validate.integer(payload.amount, false, false)) {
            cb(false, 'invalid amount')
            return
        }

        // Check if token exists and validate mint
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) throw err
            if (!token) {
                cb(false, 'token does not exist')
                return
            }
            if (token.creator !== tx.sender) {
                cb(false, 'only token creator can mint')
                return
            }
            if (token.supply + payload.amount > token.maxSupply) {
                cb(false, 'mint would exceed max supply')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        cache.updateOne('tokens', 
            {symbol: payload.symbol},
            {$inc: {supply: payload.amount}},
            function(err) {
                if (err) throw err
                
                const balance = {
                    account: payload.recipient,
                    symbol: payload.symbol,
                    balance: payload.amount,
                    timestamp: ts
                }
                
                cache.updateOne('balances',
                    {account: payload.recipient, symbol: payload.symbol},
                    {$inc: {balance: payload.amount}},
                    {upsert: true},
                    function(err) {
                        if (err) throw err
                        cb(true)
                    }
                )
            }
        )
    }
}
