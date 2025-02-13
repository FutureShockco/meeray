module.exports = {
    init: (app) => {
        /**
         * @api {get} /staking/pools Get all staking pools
         * @apiName GetStakingPools
         * @apiGroup Staking
         * @apiSuccess {Array} pools List of staking pools
         * @apiSuccess {Number} total Total number of pools
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "pools": [
         *         {
         *           "id": "TOKEN_POOL",
         *           "token": "TOKEN",
         *           "rewardToken": "REWARD",
         *           "rewardRate": "100",
         *           "lockPeriod": 86400,
         *           "totalStaked": "1000000",
         *           "active": true
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/staking/pools', (req, res) => {
            db.collection('stakingPools').find({}).toArray((err, pools) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching pools'})
                    return
                }
                res.send({
                    pools,
                    total: pools.length
                })
            })
        })

        /**
         * @api {get} /staking/pool/:id Get staking pool details
         * @apiName GetStakingPool
         * @apiGroup Staking
         * @apiParam {String} id Pool ID
         * @apiSuccess {Object} pool Pool details
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "id": "TOKEN_POOL",
         *       "token": "TOKEN",
         *       "rewardToken": "REWARD",
         *       "rewardRate": "100",
         *       "lockPeriod": 86400,
         *       "totalStaked": "1000000",
         *       "active": true,
         *       "creator": "alice",
         *       "created": 1234567890
         *     }
         */
        app.get('/staking/pool/:id', (req, res) => {
            const id = req.params.id.toUpperCase()
            
            db.collection('stakingPools').findOne({id}, (err, pool) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching pool'})
                    return
                }
                if (!pool) {
                    res.status(404).send({error: 'Pool not found'})
                    return
                }
                res.send(pool)
            })
        })

        /**
         * @api {get} /staking/stakes/:account Get account stakes
         * @apiName GetAccountStakes
         * @apiGroup Staking
         * @apiParam {String} account Account name
         * @apiParam {String} [pool] Filter by pool ID
         * @apiSuccess {Array} stakes List of stakes
         * @apiSuccess {Number} total Total number of stakes
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "stakes": [
         *         {
         *           "pool": "TOKEN_POOL",
         *           "amount": "1000",
         *           "lastRewardBlock": 1234567890,
         *           "pendingRewards": "100"
         *         }
         *       ],
         *       "total": 1
         *     }
         */
        app.get('/staking/stakes/:account', (req, res) => {
            const account = req.params.account
            const query = { account }
            
            if (req.query.pool) {
                query.pool = req.query.pool.toUpperCase()
            }

            db.collection('stakes').find(query).toArray((err, stakes) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching stakes'})
                    return
                }

                // Calculate pending rewards for each stake
                Promise.all(stakes.map(stake => new Promise((resolve, reject) => {
                    db.collection('stakingPools').findOne({id: stake.pool}, (err, pool) => {
                        if (err) {
                            reject(err)
                            return
                        }
                        
                        const currentBlock = Math.floor(Date.now() / 1000)
                        const blocksSinceLastReward = currentBlock - stake.lastRewardBlock
                        stake.pendingRewards = (parseFloat(stake.amount) * 
                            parseFloat(pool.rewardRate) * blocksSinceLastReward).toString()
                        
                        resolve(stake)
                    })
                }))).then(stakesWithRewards => {
                    res.send({
                        stakes: stakesWithRewards,
                        total: stakesWithRewards.length
                    })
                }).catch(err => {
                    res.status(500).send({error: 'Error calculating rewards'})
                })
            })
        })

        /**
         * @api {get} /staking/rewards/:account Get account pending rewards
         * @apiName GetAccountRewards
         * @apiGroup Staking
         * @apiParam {String} account Account name
         * @apiSuccess {Array} rewards List of pending rewards by pool
         * @apiSuccess {String} total Total rewards across all pools
         * @apiSuccessExample {json} Success-Response:
         *     HTTP/1.1 200 OK
         *     {
         *       "rewards": [
         *         {
         *           "pool": "TOKEN_POOL",
         *           "rewardToken": "REWARD",
         *           "amount": "100"
         *         }
         *       ],
         *       "total": "100"
         *     }
         */
        app.get('/staking/rewards/:account', (req, res) => {
            const account = req.params.account

            db.collection('stakes').find({account}).toArray((err, stakes) => {
                if (err) {
                    res.status(500).send({error: 'Error fetching stakes'})
                    return
                }

                Promise.all(stakes.map(stake => new Promise((resolve, reject) => {
                    db.collection('stakingPools').findOne({id: stake.pool}, (err, pool) => {
                        if (err) {
                            reject(err)
                            return
                        }
                        
                        const currentBlock = Math.floor(Date.now() / 1000)
                        const blocksSinceLastReward = currentBlock - stake.lastRewardBlock
                        const pendingRewards = (parseFloat(stake.amount) * 
                            parseFloat(pool.rewardRate) * blocksSinceLastReward).toString()
                        
                        resolve({
                            pool: stake.pool,
                            rewardToken: pool.rewardToken,
                            amount: pendingRewards
                        })
                    })
                }))).then(rewards => {
                    const total = rewards.reduce((acc, reward) => 
                        acc + parseFloat(reward.amount), 0).toString()
                    
                    res.send({rewards, total})
                }).catch(err => {
                    res.status(500).send({error: 'Error calculating rewards'})
                })
            })
        })
    }
}
