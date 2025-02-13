module.exports = {
    init: (app) => {
        /**
         * @api {get} /market/pairs Get all market pairs
         * @apiName GetMarketPairs
         * @apiGroup Market
         * @apiSuccess {Array} markets List of market pairs
         * @apiSuccess {Number} total Total number of markets
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "markets": [
         *         {
         *           "id": "TOKEN1_TOKEN2",
         *           "baseToken": "TOKEN1",
         *           "quoteToken": "TOKEN2",
         *           "lastPrice": "1.5",
         *           "volume24h": "1000000",
         *           "highPrice24h": "1.6",
         *           "lowPrice24h": "1.4"
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/market/pairs', (req, res) => {
            db.collection('markets').find({}).toArray((err, markets) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching markets'})
                    return
                }
                res.send({
                    markets,
                    total: markets.length
                })
            })
        })

        /**
         * @api {get} /market/pair/:id Get market pair details
         * @apiName GetMarketPair
         * @apiGroup Market
         * @apiParam {String} id Market pair ID (e.g. TOKEN1_TOKEN2)
         * @apiSuccess {Object} market Market pair details
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "id": "TOKEN1_TOKEN2",
         *       "baseToken": "TOKEN1",
         *       "quoteToken": "TOKEN2",
         *       "lastPrice": "1.5",
         *       "volume24h": "1000000",
         *       "highPrice24h": "1.6",
         *       "lowPrice24h": "1.4",
         *       "minTradeAmount": "0.0001"
         *     }
         */
        app.get('/market/pair/:id', (req, res) => {
            const id = req.params.id.toUpperCase()
            
            db.collection('markets').findOne({id}, (err, market) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching market'})
                    return
                }
                if (!market) {
                    res.status(404).send({error: 'Market not found'})
                    return
                }
                res.send(market)
            })
        })

        /**
         * @api {get} /market/orderbook/:id Get market orderbook
         * @apiName GetOrderbook
         * @apiGroup Market
         * @apiParam {String} id Market pair ID
         * @apiParam {Number} [limit=50] Number of orders per side
         * @apiSuccess {Array} bids Buy orders
         * @apiSuccess {Array} asks Sell orders
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "bids": [
         *         {
         *           "price": "1.5",
         *           "amount": "1000",
         *           "total": "1500"
         *         }
         *       ],
         *       "asks": [
         *         {
         *           "price": "1.6",
         *           "amount": "1000",
         *           "total": "1600"
         *         }
         *       ]
         *     }
         */
        app.get('/market/orderbook/:id', (req, res) => {
            const market = req.params.id.toUpperCase()
            const limit = parseInt(req.query.limit) || 50

            // Get bids (buy orders)
            db.collection('orders')
                .find({
                    market,
                    side: 'buy',
                    status: 'open'
                })
                .sort({price: -1})
                .limit(limit)
                .toArray((err, bids) => {
                    if (err) {
                        res.status(500).send({error: 'Error fetching bids'})
                        return
                    }

                    // Get asks (sell orders)
                    db.collection('orders')
                        .find({
                            market,
                            side: 'sell',
                            status: 'open'
                        })
                        .sort({price: 1})
                        .limit(limit)
                        .toArray((err, asks) => {
                            if (err) {
                                res.status(500).send({error: 'Error fetching asks'})
                                return
                            }

                            // Calculate totals
                            bids = bids.map(order => ({
                                price: order.price,
                                amount: order.amount,
                                total: (parseFloat(order.price) * parseFloat(order.amount)).toString()
                            }))

                            asks = asks.map(order => ({
                                price: order.price,
                                amount: order.amount,
                                total: (parseFloat(order.price) * parseFloat(order.amount)).toString()
                            }))

                            res.send({bids, asks})
                        })
                })
        })

        /**
         * @api {get} /market/orders/:account Get account orders
         * @apiName GetAccountOrders
         * @apiGroup Market
         * @apiParam {String} account Account name
         * @apiParam {String} [market] Filter by market
         * @apiParam {String} [status=open] Filter by status (open, filled, cancelled)
         * @apiSuccess {Array} orders List of orders
         * @apiSuccess {Number} total Total number of orders
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "orders": [
         *         {
         *           "market": "TOKEN1_TOKEN2",
         *           "type": "limit",
         *           "side": "buy",
         *           "amount": "1000",
         *           "price": "1.5",
         *           "filled": "0",
         *           "status": "open",
         *           "created": 1234567890
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/market/orders/:account', (req, res) => {
            const owner = req.params.account
            const query = { owner }
            
            if (req.query.market) {
                query.market = req.query.market.toUpperCase()
            }
            
            if (req.query.status) {
                query.status = req.query.status
            } else {
                query.status = 'open'
            }

            db.collection('orders').find(query).toArray((err, orders) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching orders'})
                    return
                }
                res.send({
                    orders,
                    total: orders.length
                })
            })
        })
    }
}
