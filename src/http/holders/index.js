module.exports = {
    init: (app) => {
        /**
         * @api {get} /holders/:symbol Get all holders of a token
         * @apiName GetTokenHolders
         * @apiGroup Holders
         * @apiParam {String} symbol Token symbol (e.g. OZT)
         * @apiSuccess {String} symbol Token symbol
         * @apiSuccess {Array} holders List of token holders
         * @apiSuccess {Number} total Total number of holders
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "symbol": "OZT",
         *       "holders": [
         *         {
         *           "name": "alice",
         *           "balance": "1000000"
         *         },
         *         {
         *           "name": "bob",
         *           "balance": "500000"
         *         }
         *       ],
         *       "total": 2
         *     }
         */
        app.get('/holders/:symbol', (req, res) => {
            const symbol = req.params.symbol.toUpperCase()
            
            // Query field to check
            const field = 'tokens.' + symbol

            // Find accounts holding this token
            const query = {}
            query[field] = { $exists: true }

            db.collection('accounts').find(query).toArray((err, accounts) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching token holders'})
                    return
                }

                // Format the response
                const holders = accounts.map(account => ({
                    name: account.name,
                    balance: account.tokens[symbol]
                }))

                // Sort by balance (highest first)
                holders.sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))

                res.send({
                    symbol: symbol,
                    holders: holders,
                    total: holders.length
                })
            })
        })

        /**
         * @api {get} /holders/:symbol/filtered Get filtered token holders with pagination
         * @apiName GetFilteredTokenHolders
         * @apiGroup Holders
         * @apiParam {String} symbol Token symbol (e.g. OZT)
         * @apiParam {Number} [min] Minimum balance filter
         * @apiParam {Number} [page=1] Page number
         * @apiParam {Number} [limit=20] Number of results per page
         * @apiSuccess {String} symbol Token symbol
         * @apiSuccess {Array} holders List of token holders
         * @apiSuccess {Number} page Current page number
         * @apiSuccess {Number} limit Results per page
         * @apiSuccess {Number} total Total number of holders matching filter
         * @apiSuccess {Number} pages Total number of pages
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "symbol": "OZT",
         *       "holders": [
         *         {
         *           "name": "alice",
         *           "balance": "1000000"
         *         },
         *         {
         *           "name": "bob",
         *           "balance": "500000"
         *         }
         *       ],
         *       "page": 1,
         *       "limit": 20,
         *       "total": 45,
         *       "pages": 3
         *     }
         */
        app.get('/holders/:symbol/filtered', (req, res) => {
            const symbol = req.params.symbol.toUpperCase()
            const minBalance = req.query.min ? parseFloat(req.query.min) : 0
            const page = parseInt(req.query.page) || 1
            const limit = parseInt(req.query.limit) || 20

            // Query field to check
            const field = 'tokens.' + symbol
            
            // Build query with minimum balance
            const query = {}
            query[field] = { 
                $exists: true,
                $gt: minBalance.toString()
            }

            // Find accounts with pagination
            db.collection('accounts').find(query)
                .skip((page - 1) * limit)
                .limit(limit)
                .toArray((err, accounts) => {
                    if (err) {
                        res.status(500).send({error: 'Error fetching token holders'})
                        return
                    }

                    // Get total count for pagination
                    db.collection('accounts').countDocuments(query, (err, total) => {
                        if (err) {
                            res.status(500).send({error: 'Error counting token holders'})
                            return
                        }

                        // Format the response
                        const holders = accounts.map(account => ({
                            name: account.name,
                            balance: account.tokens[symbol]
                        }))

                        // Sort by balance (highest first)
                        holders.sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))

                        res.send({
                            symbol: symbol,
                            holders: holders,
                            page: page,
                            limit: limit,
                            total: total,
                            pages: Math.ceil(total / limit)
                        })
                    })
                })
        })
    }
}
