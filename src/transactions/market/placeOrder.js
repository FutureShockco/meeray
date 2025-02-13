module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.market || !payload.type || !payload.price || !payload.amount) {
            cb(false, 'missing required fields')
            return
        }

        // Validate order type
        if (payload.type !== 'buy' && payload.type !== 'sell') {
            cb(false, 'invalid order type')
            return
        }

        // Validate price and amount
        if (!validate.integer(payload.price, false, false)) {
            cb(false, 'invalid price')
            return
        }
        if (!validate.integer(payload.amount, false, false)) {
            cb(false, 'invalid amount')
            return
        }

        // Check if market exists
        cache.findOne('markets', {_id: payload.market}, function(err, market) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!market) {
                cb(false, 'market does not exist')
                return
            }

            // For sell orders, check if user has enough balance
            if (payload.type === 'sell') {
                cache.findOne('balances', {
                    account: tx.sender,
                    symbol: market.baseToken
                }, function(err, balance) {
                    if (err) {
                        cb(false, 'database error')
                        return
                    }
                    if (!balance || balance.amount < payload.amount) {
                        cb(false, 'insufficient balance')
                        return
                    }
                    cb(true)
                })
            } else {
                // For buy orders, check if user has enough quote token
                const quoteAmount = payload.price * payload.amount
                cache.findOne('balances', {
                    account: tx.sender,
                    symbol: market.quoteToken
                }, function(err, balance) {
                    if (err) {
                        cb(false, 'database error')
                        return
                    }
                    if (!balance || balance.amount < quoteAmount) {
                        cb(false, 'insufficient balance')
                        return
                    }
                    cb(true)
                })
            }
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        const order = {
            market: payload.market,
            type: payload.type,
            price: payload.price,
            amount: payload.amount,
            filled: 0,
            account: tx.sender,
            created: ts,
            status: 'open'
        }

        cache.insertOne('orders', order, function(err) {
            if (err) {
                cb(false, 'error creating order')
                return
            }
            cb(true)
        })
    }
}