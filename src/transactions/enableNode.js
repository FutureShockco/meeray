module.exports = {
    fields: ['contract', 'payload', 'sender'],
    validate: (tx, ts, legitUser, cb) => {
        // we don't need to validate anything here
        cb(true)
    },
    execute: (tx, ts, cb) => {
        // because if key is incorrect, we just unset it
        if (validate.publicKey(tx.data.payload.pub, config.accountMaxLength))
            cache.updateOne('accounts', {
                name: tx.sender
            },{ $set: {
                pub_leader: tx.data.payload.pub
            }}, function(){
                cache.addLeader(tx.sender,false,() => cb(true))
            })
        else
            cache.updateOne('accounts', {
                name: tx.sender
            },{ $unset: {
                pub_leader: ''
            }}, function(){
                cache.removeLeader(tx.sender)
                cb(true)
            })
    }
}