module.exports = {
    fields: ['contractName', 'contractAction', 'contractPayload'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.contractPayload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.contractPayload
        if (!payload.collection || !payload.tokenId || !payload.to || !payload.metadata) {
            cb(false, 'missing required fields')
            return
        }

        // Validate recipient
        if (!validate.string(payload.to, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid recipient')
            return
        }

        // Check if collection exists and validate creator
        cache.findOne('nftCollections', {symbol: payload.collection}, function(err, collection) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!collection) {
                cb(false, 'collection does not exist')
                return
            }
            if (collection.creator !== tx.sender) {
                cb(false, 'only collection creator can mint')
                return
            }

            // Check if NFT ID already exists
            cache.findOne('nfts', {
                collection: payload.collection,
                tokenId: payload.tokenId
            }, function(err, nft) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (nft) {
                    cb(false, 'NFT already exists')
                    return
                }

                // Validate metadata
                if (typeof payload.metadata !== 'object') {
                    cb(false, 'invalid metadata format')
                    return
                }

                if (!payload.metadata.name || typeof payload.metadata.name !== 'string') {
                    cb(false, 'invalid name in metadata')
                    return
                }

                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.contractPayload

        // Create new NFT
        const newNFT = {
            collection: payload.collection,
            tokenId: payload.tokenId,
            owner: payload.to,
            creator: tx.sender,
            metadata: payload.metadata,
            created: ts,
            transferable: true
        }

        // Save NFT to database
        cache.insertOne('nfts', newNFT, function(err) {
            if (err) {
                cb(false, 'error creating NFT')
                return
            }

            // Update collection total supply
            cache.updateOne('nftCollections',
                {symbol: payload.collection},
                {$inc: {totalSupply: 1}},
                function(err) {
                    if (err) {
                        cb(false, 'error updating collection supply')
                        return
                    }
                    cb(true)
                }
            )
        })
    }
}
