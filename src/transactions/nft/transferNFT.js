module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.collection || !payload.tokenId || !payload.to) {
            cb(false, 'missing required fields')
            return
        }

        // Validate recipient
        if (!validate.string(payload.to, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid recipient')
            return
        }

        // Check if NFT exists and validate ownership
        cache.findOne('nfts', {
            collection: payload.collection,
            tokenId: payload.tokenId
        }, function(err, nft) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!nft) {
                cb(false, 'NFT does not exist')
                return
            }
            if (nft.owner !== tx.sender) {
                cb(false, 'not NFT owner')
                return
            }
            if (!nft.transferable) {
                cb(false, 'NFT not transferable')
                return
            }

            // Check if NFT is listed in market
            cache.findOne('nftMarket', {
                collection: payload.collection,
                tokenId: payload.tokenId,
                active: true
            }, function(err, listing) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (listing) {
                    cb(false, 'NFT is listed in market')
                    return
                }
                
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload

        // Update NFT owner
        cache.updateOne('nfts',
            {
                collection: payload.collection,
                tokenId: payload.tokenId
            },
            {
                $set: {
                    owner: payload.to,
                    lastTransferred: ts
                }
            },
            function(err) {
                if (err) {
                    cb(false, 'error transferring NFT')
                    return
                }
                cb(true)
            }
        )
    }
}
