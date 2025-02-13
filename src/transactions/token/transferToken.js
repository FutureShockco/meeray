module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        const payload = tx.data.payload
        if (!payload.symbol || !payload.amount || !payload.to) {
            cb(false, 'missing required fields')
            return
        }

        // Validate amount
        if (!validate.integer(payload.amount, false, false)) {
            cb(false, 'invalid amount')
            return
        }

        // Validate recipient
        if (!validate.string(payload.to, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid recipient')
            return
        }

        // Check if sender has enough balance
        cache.findOne('accounts', {name: tx.sender}, function(err, account) {
            if (err) throw err
            if (!account) {
                cb(false, 'sender account does not exist')
                return
            }

            if (!account.tokens || !account.tokens[payload.symbol] || account.tokens[payload.symbol] < payload.amount) {
                cb(false, 'insufficient balance')
                return
            }

            cb(true)
        })
    },
    execute: (tx, ts, cb) => {
        const payload = tx.data.payload
        const amount = parseInt(payload.amount)

        // Remove from sender
        cache.findOne('accounts', {name: tx.sender}, function(err, senderAccount) {
            if (err) {
                cb(false, 'error getting sender account')
                return
            }

            // Update sender's token balance
            senderAccount.tokens[payload.symbol] -= amount

            cache.updateOne('accounts',
                {name: tx.sender},
                {$set: {tokens: senderAccount.tokens}},
                function(err) {
                    if (err) {
                        cb(false, 'error updating sender balance')
                        return
                    }

                    // Get recipient account
                    cache.findOne('accounts', {name: payload.to}, function(err, recipientAccount) {
                        if (err) {
                            cb(false, 'error getting recipient account')
                            return
                        }

                        // Initialize token balance if it doesn't exist
                        if (!recipientAccount.tokens) {
                            recipientAccount.tokens = {}
                        }
                        if (!recipientAccount.tokens[payload.symbol]) {
                            recipientAccount.tokens[payload.symbol] = 0
                        }

                        // Update recipient's token balance
                        recipientAccount.tokens[payload.symbol] += amount

                        // Save updated recipient account
                        cache.updateOne('accounts',
                            {name: payload.to},
                            {$set: {tokens: recipientAccount.tokens}},
                            function(err) {
                                if (err) {
                                    cb(false, 'error updating recipient balance')
                                    return
                                }
                                cb(true)
                            }
                        )
                    })
                }
            )
        })
    }
}
