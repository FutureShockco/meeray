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

        // Check if token exists and if sender has enough balance
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) throw err
            if (!token) {
                cb(false, 'token does not exist')
                return
            }

            cache.findOne('balances', {account: tx.sender, symbol: payload.symbol}, function(err, balance) {
                if (err) throw err
                if (!balance || balance.balance < payload.amount) {
                    cb(false, 'insufficient balance')
                    return
                }
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        
        // Deduct from sender
        cache.updateOne('balances',
            {account: tx.sender, symbol: payload.symbol},
            {$inc: {balance: -payload.amount}},
            function(err) {
                if (err) throw err

                // Add to recipient
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
