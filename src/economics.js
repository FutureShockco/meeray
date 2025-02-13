const TransactionType = require('./transactions').Types

// List of potential community-breaking abuses:
// 1- Multi accounts voting (cartoons)
// 2- Bid-bots (selling votes)
// 3- Self-voting whales (haejin)
// 4- Curation trails (bots auto-voting tags or authors)

// What we decided:
// 1- Flat curation
// 2- Money goes into content, claim button stops curation rewards
// 3- People can claim curation rewards after X days. Time lock to allow downvotes to take away rewards
// 4- Rentability curve: based on time since the vote was cast. Starts at X%, goes up to 100% at optimal voting time, then goes down to Y% at the payout time and after.
// 5- Downvotes print the same DTC amount as an upvote would. But they also reduce upvote rewards by X% of that amount
// 6- Use weighted averages for rewardPool data to smooth it out

let eco = {
    startRewardPool: null,
    lastRewardPool: null,
    currentBlock: {
        dist: 0,
        burn: 0,
        votes: 0
    },
    history: [],
    nextBlock: () => {
        eco.currentBlock.dist = 0
        eco.currentBlock.burn = 0
        eco.currentBlock.votes = 0
        if (eco.startRewardPool)
            eco.lastRewardPool = eco.startRewardPool
        eco.startRewardPool = null
    },
    loadHistory: () => {
        eco.history = []
        let lastCBurn = 0
        let lastCDist = 0
        let firstBlockIndex = chain.recentBlocks.length - config.ecoBlocks
        if (firstBlockIndex < 0) firstBlockIndex = 0
        for (let i = firstBlockIndex; i < chain.recentBlocks.length; i++) {
            const block = chain.recentBlocks[i]
            if (block.burn)
                lastCBurn += block.burn
            if (block.dist)
                lastCDist += block.dist

            eco.history.push({_id: block._id, votes: eco.tallyVotes(block.txs)})
        }

        eco.history[eco.history.length-1].cDist = eco.round(lastCDist)
        eco.history[eco.history.length-1].cBurn = eco.round(lastCBurn)
    },
    appendHistory: (nextBlock) => {
        // nextBlock should yet to be added to recentBlocks
        let lastIdx = chain.recentBlocks.length-config.ecoBlocks
        let oldDist = lastIdx >= 0 ? chain.recentBlocks[lastIdx].dist || 0 : 0
        let oldBurn = lastIdx >= 0 ? chain.recentBlocks[lastIdx].burn || 0 : 0
        eco.history.push({
            _id: nextBlock._id,
            votes: eco.tallyVotes(nextBlock.txs),
            cDist: eco.round(eco.history[eco.history.length-1].cDist - oldDist + (nextBlock.dist || 0)),
            cBurn: eco.round(eco.history[eco.history.length-1].cBurn - oldBurn + (nextBlock.burn || 0))
        })
    },
    cleanHistory: () => {
        if (config.ecoBlocksIncreasesSoon) return
        let extraBlocks = eco.history.length - config.ecoBlocks
        while (extraBlocks > 0) {
            eco.history.shift()
            extraBlocks--
        }
    },
    tallyVotes: (txs = []) => {
        let votes = 0
        for (let y = 0; y < txs.length; y++)
            if (txs[y].type === TransactionType.VOTE
                || txs[y].type === TransactionType.COMMENT
                || txs[y].type === TransactionType.PROMOTED_COMMENT
                || (txs[y].type === TransactionType.TIPPED_VOTE))
                votes += Math.abs(txs[y].data.vt)
        return votes
    },
    rewardPool: () => {
        let theoricalPool = config.rewardPoolAmount
        let burned = 0
        let distributed = 0
        let votes = 0
        if (!eco.startRewardPool) {
            distributed = eco.history[eco.history.length-1].cDist
            burned = eco.history[eco.history.length-1].cBurn
            let firstBlockIndex = eco.history.length - config.ecoBlocks
            if (firstBlockIndex < 0) firstBlockIndex = 0
            let weight = 1
            for (let i = firstBlockIndex; i < eco.history.length; i++) {
                votes += eco.history[i].votes*weight
                weight++
            }

            // weighted average for votes
            votes /= (weight+1)/2

            eco.startRewardPool = {
                burn: burned,
                dist: distributed,
                votes: votes,
                theo: theoricalPool,
                avail: theoricalPool - distributed
            }
        } else {
            burned = eco.startRewardPool.burn
            distributed = eco.startRewardPool.dist
            votes = eco.startRewardPool.votes
        }
        

        let avail = theoricalPool - distributed - eco.currentBlock.dist
        if (avail < 0) avail = 0
        burned += eco.currentBlock.burn
        distributed += eco.currentBlock.dist
        votes += eco.currentBlock.votes

        avail = eco.round(avail)
        burned = eco.round(burned)
        distributed = eco.round(distributed)
        votes = eco.round(votes)
        return {
            theo: theoricalPool,
            burn: burned,
            dist: distributed,
            votes: votes,
            avail: avail
        }
    },
    accountPrice: (username) => {
        let price = config.accountPriceMin
        let extra = config.accountPriceBase - config.accountPriceMin
        let mult = Math.pow(config.accountPriceChars / username.length, config.accountPriceCharMult)
        price += Math.round(extra*mult)
        return price
    },
    print: (vt) => {
        // loads current reward pool data
        // and converts VP to DTC based on reward pool stats
        let stats = eco.rewardPool()
        // if reward pool is empty, print nothing
        // (can only happen if witnesses freeze distribution in settings)
        if (stats.avail === 0)
            return 0

        let thNewCoins = 0

        // if theres no vote in reward pool stats, we print 1 coin (minimum)
        if (stats.votes === 0)
            thNewCoins = 1
        // otherwise we proportionally reduce based on recent votes weight
        // and how much is available for printing
        else
            thNewCoins = stats.avail * Math.abs((vt) / stats.votes)

        // rounding down
        thNewCoins = eco.floor(thNewCoins)
        
        // and making sure one person cant empty the whole pool when network has been inactive
        // e.g. when stats.votes close to 0
        // then vote value will be capped to rewardPoolMaxShare %
        if (thNewCoins > Math.floor(stats.avail*config.rewardPoolMaxShare))
            thNewCoins = Math.floor(stats.avail*config.rewardPoolMaxShare)

        logr.econ('PRINT:'+vt+' VT => '+thNewCoins+' dist', stats.avail)
        return thNewCoins
    },
    rentability: (ts1, ts2, isDv) => {
        let ts = ts2 - ts1
        if (ts < 0) throw 'Invalid timestamp in rentability calculation'

        // https://imgur.com/a/GTLvs37
        let directionRent = isDv ? config.ecoDvRentFactor : 1
        let startRentability = config.ecoStartRent
        let baseRentability = config.ecoBaseRent
        let rentabilityStartTime = config.ecoRentStartTime
        let rentabilityEndTime = config.ecoRentEndTime
        let claimRewardTime = config.ecoClaimTime

        // requires that :
        // rentabilityStartTime < rentabilityEndTime < claimRewardTime

        // between rentStart and rentEnd => 100% max rentability
        let rentability = 1

        if (ts === 0)
            rentability = startRentability
        
        else if (ts < rentabilityStartTime)
            // less than one day, rentability grows from 50% to 100%
            rentability = startRentability + (1-startRentability) * ts / rentabilityStartTime

        else if (ts >= claimRewardTime)
            // past 7 days, 50% base rentability
            rentability = baseRentability

        else if (ts > rentabilityEndTime)
            // more than 3.5 days but less than 7 days
            // decays from 100% to 50%
            rentability = baseRentability + (1-baseRentability) * (claimRewardTime-ts) / (claimRewardTime-rentabilityEndTime)


        rentability = Math.floor(directionRent*rentability*Math.pow(10, config.ecoRentPrecision))/Math.pow(10, config.ecoRentPrecision)
        return rentability
    },
    round: (val = 0) => Math.round(val*Math.pow(10,config.ecoClaimPrecision))/Math.pow(10,config.ecoClaimPrecision),
    floor: (val = 0) => Math.floor(val*Math.pow(10,config.ecoClaimPrecision))/Math.pow(10,config.ecoClaimPrecision)
} 

module.exports = eco