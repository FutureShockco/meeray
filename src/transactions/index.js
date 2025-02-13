const { performance } = require('perf_hooks')
const WARN_SLOW_VALID = process.env.WARN_SLOW_VALID || 5
const WARN_SLOW_EXEC = process.env.WARN_SLOW_EXEC || 5

const transactions = [
    require('./transfer.js'),
    require('./approveNode.js'),
    require('./disaproveNode.js'),
    require('./enableNode.js'),
    require('./userJson.js'),
    // DAO transactions
    require('./dao/chainUpdateCreate.js'),
    require('./dao/fundRequestCreate.js'),
    require('./dao/fundRequestContrib.js'),
    require('./dao/fundRequestWork.js'),
    require('./dao/fundRequestWorkReview.js'),
    require('./dao/proposalEdit.js'),
    require('./dao/proposalVote.js'),
    require('./dao/mdQueue.js'),
    require('./dao/mdSign.js'),
    // Token transactions
    require('./token/createTokens.js'),
    require('./token/mintTokens.js'),
    require('./token/transferTokens.js'),
    // NFT transactions
    require('./nft/createCollection.js'),
    require('./nft/mintNFT.js'),
    require('./nft/transferNFT.js'),
    // Market transactions
    require('./market/createMarket.js'),
    require('./market/placeOrder.js'),
    // Staking transactions
    require('./staking/createPool.js'),
    require('./staking/stake.js'),
    require('./staking/unstake.js')
]

module.exports = {
    Types: {
        TRANSFER: 0,
        APPROVE_NODE: 1,
        DISAPPROVE_NODE: 2,
        ENABLE_NODE: 3,
        USER_JSON: 4,
        // DAO transaction types
        DAO_CHAIN_UPDATE_CREATE: 5,
        DAO_FUND_REQUEST_CREATE: 6,
        DAO_FUND_REQUEST_CONTRIB: 7,
        DAO_FUND_REQUEST_WORK: 8,
        DAO_FUND_REQUEST_WORK_REVIEW: 9,
        DAO_PROPOSAL_EDIT: 10,
        DAO_PROPOSAL_VOTE: 11,
        DAO_MD_QUEUE: 12,
        DAO_MD_SIGN: 13,
        // Token transaction types
        CREATE_TOKENS: 14,
        MINT_TOKENS: 15,
        TRANSFER_TOKENS: 16,
        // NFT transaction types
        CREATE_NFT_COLLECTION: 17,
        MINT_NFT: 18,
        TRANSFER_NFT: 19,
        // Market transaction types
        CREATE_MARKET: 20,
        PLACE_ORDER: 21,
        // Staking transaction types
        CREATE_STAKING_POOL: 22,
        STAKE_TOKENS: 23,
        UNSTAKE_TOKENS: 24
    },
    validate: (tx, ts, legitUser, cb) => {
        logr.debug('tx:' + tx.type + ' validation begins')
        let startTime = performance.now()
        if (!transactions[tx.type] || !transactions[tx.type].validate) {
            cb(false, 'invalid tx type'); return
        }

        transactions[tx.type].validate(tx, ts, legitUser, function (isValid, error) {
            let timeDiff = performance.now() - startTime
            if (timeDiff > WARN_SLOW_VALID)
                logr.warn('Slow tx type:' + tx.type + ' validation took: ' + timeDiff.toFixed(3) + 'ms')
            else
                logr.perf('tx:' + tx.type + ' validation finish: ' + timeDiff.toFixed(3) + 'ms')

            cb(isValid, error)
        })
    },
    execute: (tx, ts, cb) => {
        let startTime = performance.now()
        if (!transactions[tx.type] || !transactions[tx.type].execute) {
            logr.error('No execute function for type '+tx.type)
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
