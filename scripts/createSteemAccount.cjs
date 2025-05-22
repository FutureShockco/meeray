const { PrivateKey } = require('dsteem');
const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.justyy.com')
const PrivateKey = require('dsteem').PrivateKey

const creator = 'creator'
const creatorKey = 'XXX'

function createSteemAccount(name) {
    try {
        const name = req.params.name;
        if (!name || name.length < 3) {
            return res.status(400).json({ error: 'Name must be at least 3 characters long' });
        }

        let password = Array(10).fill("0123456789abcdefghijklmnopqrstuvwxyz").map(function (x) { return x[Math.floor(Math.random() * x.length)] }).join('');
        let ops = [];
        let steem_name = accountPrefix + name;

        let privateKey = PrivateKey.fromString(creatorKey);
        const ownerKey = PrivateKey.fromLogin(steem_name, password, 'owner');
        const activeKey = PrivateKey.fromLogin(steem_name, password, 'active');
        const postingKey = PrivateKey.fromLogin(steem_name, password, 'posting');
        let memoKey = PrivateKey.fromLogin(steem_name, password, 'memo').createPublic();

        const newaccount = {
            ownerKey: ownerKey.toString(),
            activeKey: activeKey.toString(),
            postingKey: postingKey.toString(),
            memo_key: memoKey.toString()
        };

        const ownerAuth = {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[ownerKey.createPublic(), 1]],
        };
        const activeAuth = {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[activeKey.createPublic(), 1]],
        };
        const postingAuth = {
            weight_threshold: 1,
            account_auths: postingAuthorities,
            key_auths: [[postingKey.createPublic(), 1]],
        };
        const create_op = [
            'create_claimed_account',
            {
                creator: creator,
                new_account_name: steem_name,
                owner: ownerAuth,
                active: activeAuth,
                posting: postingAuth,
                memo_key: memoKey,
                json_metadata: '',
                extensions: [],
            }
        ];
        ops.push(create_op);

        client.broadcast.sendOperations(ops, privateKey).then(function (result) {
            if (result) {
                console.log(result);
                let delegation = process.env.DELEGATION_AMOUNT || "6020.000000 VESTS";
                if (result && process.env.SHOULD_DELEGATE === 'true') {
                    client.broadcast.delegateVestingShares({
                        delegator: creator,
                        delegatee: steem_name,
                        vesting_shares: delegation
                    }, privateKey, function (err, result) {
                        if (result) {
                            res.json(newaccount)
                        }
                        else {
                            console.log(err)
                            res.status(500).json({ error: err })
                        }
                    });
                } else {
                    res.json(newaccount)
                }
            }
        },
            function (error) {
                console.log(error)
                res.status(500).json({ error: error })
            }
        )
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

createSteemAccount('echelon-node7')