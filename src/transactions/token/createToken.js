module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        const payload = tx.data.payload
        if (!payload.symbol || !payload.name || !payload.precision || !payload.maxSupply) {
            cb(false, 'missing required fields')
            return
        }

        // Validate symbol format
        if (!validate.string(payload.symbol, 10, 3)) {
            cb(false, 'invalid token symbol length')
            return
        }
        if (!/^[A-Z]+$/.test(payload.symbol)) {
            cb(false, 'invalid token symbol format')
            return
        }

        // Validate name format
        if (!validate.string(payload.name, 50, 1)) {
            cb(false, 'invalid token name')
            return
        }

        // Validate precision
        if (!Number.isInteger(payload.precision) || payload.precision < 0 || payload.precision > 8) {
            cb(false, 'invalid token precision')
            return
        }

        // Validate max supply
        if (!validate.integer(payload.maxSupply, false, false)) {
            cb(false, 'invalid max supply')
            return
        }

        // Check if token already exists
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) throw err
            if (token) {
                cb(false, 'token already exists')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const token = {
            name: tx.data.payload.name,
            symbol: tx.data.payload.symbol,
            currentSupply: 0,
            maxSupply: tx.data.payload.maxSupply,
            precision: tx.data.payload.precision,
            creator: tx.sender,
            created: ts
        }
        cache.insertOne('tokens', token, function(err) {
            if (err) throw err
            cb(true)
        })
    }
}
