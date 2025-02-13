module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        if (!tx.data.payload) {
            cb(false, 'missing contract payload')
            return
        }

        const payload = tx.data.payload
        if (!payload.token || !payload.amount) {
            cb(false, 'missing required fields')
            return
        }

        // Validate amount
        if (!validate.integer(payload.amount, false, false)) {
            cb(false, 'invalid amount')
            return
        }

        // Check if pool exists
        cache.findOne('stakingPools', {token: payload.token}, function(err, pool) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!pool) {
                cb(false, 'pool does not exist')
                return
            }

            // Check if user has enough balance
            cache.findOne('balances', {
                account: tx.sender,
                symbol: payload.token
            }, function(err, balance) {
                if (err) {
                    cb(false, 'database error')
                    return
                }
                if (!balance || balance.amount < payload.amount) {
                    cb(false, 'insufficient balance')
                    return
                }
                cb(true)
            })
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload

        // First deduct from user's balance
        cache.updateOne('balances',
            {
                account: tx.sender,
                symbol: payload.token
            },
            {$inc: {amount: -payload.amount}},
            function(err) {
                if (err) {
                    cb(false, 'error updating balance')
                    return
                }

                // Then add to staking pool
                cache.updateOne('stakingPools',
                    {token: payload.token},
                    {$inc: {totalStaked: payload.amount}},
                    function(err) {
                        if (err) {
                            cb(false, 'error updating pool')
                            return
                        }

                        // Finally record the stake
                        const stake = {
                            account: tx.sender,
                            token: payload.token,
                            amount: payload.amount,
                            since: ts
                        }

                        cache.insertOne('stakes', stake, function(err) {
                            if (err) {
                                cb(false, 'error recording stake')
                                return
                            }
                            cb(true)
                        })
                    }
                )
            }
        )
    }
}