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

        // Check if user has enough staked
        cache.findOne('stakes', {
            account: tx.sender,
            token: payload.token
        }, function(err, stake) {
            if (err) {
                cb(false, 'database error')
                return
            }
            if (!stake || stake.amount < payload.amount) {
                cb(false, 'insufficient staked amount')
                return
            }
            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload

        // First reduce stake amount
        cache.updateOne('stakes',
            {
                account: tx.sender,
                token: payload.token
            },
            {$inc: {amount: -payload.amount}},
            function(err) {
                if (err) {
                    cb(false, 'error updating stake')
                    return
                }

                // Then reduce pool total
                cache.updateOne('stakingPools',
                    {token: payload.token},
                    {$inc: {totalStaked: -payload.amount}},
                    function(err) {
                        if (err) {
                            cb(false, 'error updating pool')
                            return
                        }

                        // Finally return tokens to user
                        cache.updateOne('balances',
                            {
                                account: tx.sender,
                                symbol: payload.token
                            },
                            {$inc: {amount: payload.amount}},
                            function(err) {
                                if (err) {
                                    cb(false, 'error updating balance')
                                    return
                                }
                                cb(true)
                            }
                        )
                    }
                )
            }
        )
    }
}