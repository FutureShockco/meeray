module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.symbol || !payload.name || !payload.metadata) {
            cb(false, 'missing required fields')
            return
        }

        // Validate symbol format
        if (!validate.string(payload.symbol, config.tokenSymbolMaxLength, config.tokenSymbolMinLength, true, false)) {
            cb(false, 'invalid symbol format')
            return
        }

        // Check if collection already exists
        cache.findOne('nftCollections', {symbol: payload.symbol}, function(err, collection) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (collection) {
                cb(false, 'collection already exists')
                return
            }

            // Validate metadata
            if (typeof payload.metadata !== 'object') {
                cb(false, 'invalid metadata format')
                return
            }

            if (!payload.metadata.description || typeof payload.metadata.description !== 'string') {
                cb(false, 'invalid description in metadata')
                return
            }

            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload

        // Create new NFT collection
        const newCollection = {
            symbol: payload.symbol,
            name: payload.name,
            creator: tx.sender,
            metadata: payload.metadata,
            created: ts,
            totalSupply: '0'
        }

        // Save to database
        cache.insertOne('nftCollections', newCollection, function(err) {
            if (err) {
                cb(false, 'error creating collection')
                return
            }
            cb(true)
        })
    }
}
