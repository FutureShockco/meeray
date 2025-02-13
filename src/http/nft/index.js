module.exports = {
    init: (app) => {
        /**
         * @api {get} /nft/collections Get all NFT collections
         * @apiName GetNFTCollections
         * @apiGroup NFT
         * @apiSuccess {Array} collections List of NFT collections
         * @apiSuccess {Number} total Total number of collections
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "collections": [
         *         {
         *           "symbol": "MYNFT",
         *           "name": "My NFT Collection",
         *           "creator": "alice",
         *           "totalSupply": "100",
         *           "metadata": {
         *             "description": "Collection description",
         *             "image": "ipfs://..."
         *           }
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/nft/collections', (req, res) => {
            db.collection('nftCollections').find({}).toArray((err, collections) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching collections'})
                    return
                }
                res.send({
                    collections: collections,
                    total: collections.length
                })
            })
        })

        /**
         * @api {get} /nft/collection/:symbol Get NFT collection details
         * @apiName GetNFTCollection
         * @apiGroup NFT
         * @apiParam {String} symbol Collection symbol
         * @apiSuccess {Object} collection Collection details
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "symbol": "MYNFT",
         *       "name": "My NFT Collection",
         *       "creator": "alice",
         *       "totalSupply": "100",
         *       "metadata": {
         *         "description": "Collection description",
         *         "image": "ipfs://..."
         *       }
         *     }
         */
        app.get('/nft/collection/:symbol', (req, res) => {
            const symbol = req.params.symbol.toUpperCase()
            
            db.collection('nftCollections').findOne({symbol}, (err, collection) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching collection'})
                    return
                }
                if (!collection) {
                    res.status(404).send({error: 'Collection not found'})
                    return
                }
                res.send(collection)
            })
        })

        /**
         * @api {get} /nft/tokens/:collection Get NFTs in a collection
         * @apiName GetCollectionNFTs
         * @apiGroup NFT
         * @apiParam {String} collection Collection symbol
         * @apiParam {Number} [page=1] Page number
         * @apiParam {Number} [limit=20] Results per page
         * @apiSuccess {Array} tokens List of NFTs
         * @apiSuccess {Number} total Total number of NFTs
         * @apiSuccess {Number} page Current page
         * @apiSuccess {Number} pages Total pages
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "tokens": [
         *         {
         *           "collection": "MYNFT",
         *           "tokenId": "1",
         *           "owner": "alice",
         *           "metadata": {
         *             "name": "NFT #1",
         *             "image": "ipfs://..."
         *           }
         *         }
         *       ],
         *       "total": 100,
         *       "page": 1,
         *       "pages": 5
         *     }
         */
        app.get('/nft/tokens/:collection', (req, res) => {
            const collection = req.params.collection.toUpperCase()
            const page = parseInt(req.query.page) || 1
            const limit = parseInt(req.query.limit) || 20

            db.collection('nfts')
                .find({collection})
                .skip((page - 1) * limit)
                .limit(limit)
                .toArray((err, tokens) => {
                    if (err) {
                        res.status(500).send({error: 'Error fetching NFTs'})
                        return
                    }

                    db.collection('nfts').countDocuments({collection}, (err, total) => {
                        if (err) {
                            res.status(500).send({error: 'Error counting NFTs'})
                            return
                        }

                        res.send({
                            tokens,
                            total,
                            page,
                            pages: Math.ceil(total / limit)
                        })
                    })
                })
        })

        /**
         * @api {get} /nft/token/:collection/:tokenId Get NFT details
         * @apiName GetNFTDetails
         * @apiGroup NFT
         * @apiParam {String} collection Collection symbol
         * @apiParam {String} tokenId Token ID
         * @apiSuccess {Object} token NFT details
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "collection": "MYNFT",
         *       "tokenId": "1",
         *       "owner": "alice",
         *       "creator": "alice",
         *       "metadata": {
         *         "name": "NFT #1",
         *         "image": "ipfs://..."
         *       }
         *     }
         */
        app.get('/nft/token/:collection/:tokenId', (req, res) => {
            const collection = req.params.collection.toUpperCase()
            const tokenId = req.params.tokenId

            db.collection('nfts').findOne({
                collection,
                tokenId
            }, (err, token) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching NFT'})
                    return
                }
                if (!token) {
                    res.status(404).send({error: 'NFT not found'})
                    return
                }
                res.send(token)
            })
        })

        /**
         * @api {get} /nft/account/:account Get account's NFTs
         * @apiName GetAccountNFTs
         * @apiGroup NFT
         * @apiParam {String} account Account name
         * @apiParam {String} [collection] Filter by collection
         * @apiSuccess {Array} tokens List of NFTs owned by account
         * @apiSuccess {Number} total Total number of NFTs
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "tokens": [
         *         {
         *           "collection": "MYNFT",
         *           "tokenId": "1",
         *           "metadata": {
         *             "name": "NFT #1",
         *             "image": "ipfs://..."
         *           }
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/nft/account/:account', (req, res) => {
            const owner = req.params.account
            const query = { owner }
            
            if (req.query.collection) {
                query.collection = req.query.collection.toUpperCase()
            }

            db.collection('nfts').find(query).toArray((err, tokens) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching NFTs'})
                    return
                }
                res.send({
                    tokens,
                    total: tokens.length
                })
            })
        })
    }
}
