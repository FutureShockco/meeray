const { performance } = require('perf_hooks')
const WARN_SLOW_VALID = process.env.WARN_SLOW_VALID || 5
const WARN_SLOW_EXEC = process.env.WARN_SLOW_EXEC || 5

const transactions = [
    require('./newAccount.js'),
    require('./approveNode.js'),
    require('./disaproveNode.js'),
    require('./transfer.js'),
    require('./userJson.js'),
    require('./newKey.js'),
    require('./removeKey.js'),
    require('./changePassword.js'),
    require('./enableNode.js'),
    require('./newWeightedKey.js'),
    require('./setSignThreshold.js'),
    require('./setPasswordWeight.js'),
    require('./unsetSignThreshold.js'),
    require('./newAccountWithBw.js'),
    require('./commentEdit.js'),
    require('./accountAuthorize.js'),
    require('./accountRevoke.js'),
    require('./dao/fundRequestCreate.js'),
    require('./dao/fundRequestContrib'),
    require('./dao/fundRequestWork'),
    require('./dao/fundRequestWorkReview.js'),
    require('./dao/proposalVote.js'),
    require('./dao/proposalEdit.js'),
    require('./dao/chainUpdateCreate.js'),
    require('./dao/mdQueue.js'),
    require('./dao/mdSign.js'),
    require('./createTokens.js'),
    require('./mintTokens.js'),
    require('./transferTokens.js')
]

module.exports = {
    Types: {
        NEW_ACCOUNT: 0,
        APPROVE_NODE_OWNER: 1,
        DISAPROVE_NODE_OWNER: 2,
        TRANSFER: 3,
        USER_JSON: 4,
        NEW_KEY: 5,
        REMOVE_KEY: 6,
        CHANGE_PASSWORD: 7,
        ENABLE_NODE: 8,
        NEW_WEIGHTED_KEY: 9,
        SET_SIG_THRESHOLD: 10,
        SET_PASSWORD_WEIGHT: 11,
        UNSET_SIG_THRESHOLD: 12,
        NEW_ACCOUNT_WITH_BW: 13,
        COMMENT_EDIT: 14,
        ACCOUNT_AUTHORIZE: 15,
        ACCOUNT_REVOKE: 16,
        DAO_FUND_REQUEST_CREATE: 17,
        DAO_FUND_REQUEST_CONTRIB: 18,
        DAO_FUND_REQUEST_WORK: 19,
        DAO_FUND_REQUEST_WORK_REVIEW: 20,
        DAO_PROPOSAL_VOTE: 21,
        DAO_PROPOSAL_EDIT: 22,
        DAO_CHAIN_UPDATE_CREATE: 23,
        DAO_MD_QUEUE: 24,
        DAO_MD_SIGN: 25,
        CREATE_TOKENS: 26,
        MINT_TOKENS: 27,
        TRANSFER_TOKENS: 28
    },
    validate: (tx, ts, legitUser, cb) => {
        logr.debug('tx:' + tx.type + ' validation begins')
        let startTime = performance.now()
        // will make sure the transaction type exists (redondant ?)
        if (!transactions[tx.type]) {
            logr.error('No transaction type ?!')
            cb(false, 'forbidden transaction type'); return
        }

        // enforce there's no unknown field included in the transaction
        for (let i = 0; i < Object.keys(tx.data).length; i++)
            if (transactions[tx.type].fields.indexOf(Object.keys(tx.data)[i]) === -1) {
                cb(false, 'unknown tx.data.' + Object.keys(tx.data)[i])
                return
            }
        transactions[tx.type].validate(tx, ts, legitUser, function (isValid, error) {
            let timeDiff = performance.now() - startTime
            if (timeDiff > WARN_SLOW_VALID)
                logr.warn('Slow tx type:' + tx.type + ' validation took: ' + timeDiff.toFixed(3) + 'ms')
            else
                logr.perf('tx:' + tx.type + ' validation finish: ' + timeDiff.toFixed(3) + 'ms')
            console.log(isValid, error)

            cb(isValid, error)
        })
    },
    execute: (tx, ts, cb) => {
        // logr.debug('tx:'+tx.type+' execution begins')
        let startTime = performance.now()
        if (!transactions[tx.type]) {
            cb(false); return
        }
        transactions[tx.type].execute(tx, ts, function (isValid, dist, burn) {
            let timeDiff = performance.now() - startTime

            if (timeDiff > WARN_SLOW_EXEC)
                logr.warn('Slow tx type:' + tx.type + ' execution took: ' + timeDiff.toFixed(3) + 'ms')
            else
                logr.perf('tx:' + tx.type + ' execution finish: ' + timeDiff.toFixed(3) + 'ms')

            cb(isValid, dist, burn)
        })
    },
    transactions: transactions
}
