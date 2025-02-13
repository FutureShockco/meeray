module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.token || !payload.apr) {
            cb(false, 'missing required fields')
            return
        }

        // Validate APR
        if (!validate.integer(payload.apr, false, false) || payload.apr > 10000) { // Max 100%
            cb(false, 'invalid apr')
            return
        }

        // Check if token exists
        cache.findOne('tokens', {symbol: payload.token}, function(err, token) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!token) {
                cb(false, 'token does not exist')
                return
            }

            // Check if pool already exists
            cache.findOne('stakingPools', {token: payload.token}, function(err, pool) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (pool) {
                    cb(false, 'pool already exists')
                    return
                }
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        const pool = {
            token: payload.token,
            apr: payload.apr,
            totalStaked: 0,
            creator: tx.sender,
            created: ts
        }

        cache.insertOne('stakingPools', pool, function(err) {
            if (err) {
                cb(false, 'error creating pool')
                return
            }
            cb(true)
        })
    }
}