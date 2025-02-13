module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.baseToken || !payload.quoteToken) {
            cb(false, 'missing required fields')
            return
        }

        // Check if market already exists
        cache.findOne('markets', {
            baseToken: payload.baseToken,
            quoteToken: payload.quoteToken
        }, function(err, market) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (market) {
                cb(false, 'market already exists')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        const market = {
            baseToken: payload.baseToken,
            quoteToken: payload.quoteToken,
            creator: tx.sender,
            created: ts,
            lastPrice: 0,
            volume24h: 0
        }

        cache.insertOne('markets', market, function(err) {
            if (err) {
                cb(false, 'error creating market')
                return
            }
            cb(true)
        })
    }
}