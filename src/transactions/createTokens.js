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
            cb(false, 'token symbol must be uppercase letters only')
            return
        }

        // Validate name
        if (!validate.string(payload.name, 50, 3)) {
            cb(false, 'invalid token name length')
            return
        }

        // Validate precision
        if (!Number.isInteger(payload.precision) || payload.precision < 0 || payload.precision > 8) {
            cb(false, 'precision must be integer between 0 and 8')
            return
        }

        // Validate maxSupply
        const maxSupply = parseFloat(payload.maxSupply)
        if (isNaN(maxSupply) || maxSupply <= 0) {
            cb(false, 'invalid max supply')
            return
        }

        // Check if token already exists
        cache.findOne('tokens', {symbol: payload.symbol}, function(err, token) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (token) {
                cb(false, 'token already exists')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.contractPayload
        const token = {
            symbol: payload.symbol,
            name: payload.name,
            precision: payload.precision,
            maxSupply: payload.maxSupply,
            currentSupply: '0',
            creator: tx.data.sender,
            created: ts
        }

        // Create the token
        cache.insertOne('tokens', token, function(err) {
            if (err) {
                cb(false, 'error creating token')
                return
            }
            cb(true)
        })
    }
}
