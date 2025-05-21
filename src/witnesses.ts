import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import p2p from './p2p.js';
import transaction from './transaction.js';

export const witnessesModule = {

    witnessSchedule: (block: any) => {
        let hash = block.hash;
        let rand = parseInt('0x' + hash.substr(hash.length - config.witnessShufflePrecision));
        if (!p2p.recovering) logger.debug('Generating schedule... NRNG: ' + rand);
        let witnesses = witnessesModule.generateWitnesses(true, false, config.witnesses, 0);
        witnesses = witnesses.sort((a: any, b: any) => {
            if (a.name < b.name) return -1;
            if (a.name > b.name) return 1;
            return 0;
        });
        let shuffledWitnesses: any[] = [];
        while (witnesses.length > 0) {
            let i = rand % witnesses.length;
            shuffledWitnesses.push(witnesses[i]);
            witnesses.splice(i, 1);
        }
        let y = 0;
        while (shuffledWitnesses.length < config.witnesses) {
            shuffledWitnesses.push(shuffledWitnesses[y]);
            y++;
        }
        return {
            block: block,
            shuffle: shuffledWitnesses
        };
    },


    witnessRewards: (name: string, ts: number, cb: (dist: number) => void) => {
        cache.findOne('accounts', { name: name }, async function (err: any, account: any) {
            if (err) {
                logger.error('Error finding account for witness rewards:', err);
                return cb(0);
            }

            if (!account) {
                logger.error('Account not found for witness rewards:', name);
                return cb(0);
            }

            // Calculate the new balance with the reward
            const reward = config.witnessReward;
            let newBalance = (account.tokens?.ECH || 0) + reward;
            if (reward > 0) {
                // Update the account balance using dot notation for the ECH field within tokens
                cache.updateOne(
                    'accounts',
                    { name: account.name },
                    { $set: { "tokens.ECH": newBalance } },
                    function (err: Error | null, result?: boolean) {
                        if (err) {
                            logger.error('Error updating account balance for rewards:', err);
                            return cb(0);
                        }
                        
                        if (result === false) {
                            logger.warn(`[witnessRewards] cache.updateOne for ${account.name} reported no document was updated.`);
                        }

                        // Adjust node approval if needed
                        transaction.adjustNodeAppr(account, reward, function () {
                            logger.debug(`Distributed ${reward} to witness ${name}`);
                            cb(reward);
                        });
                    }
                );
            } else {
                // No rewards to distribute
                cb(0);
            }
        });
    },

    generateWitnesses: (withWitnessPub: boolean, withWs: boolean, limit: number, start: number) => {
        let witnesses: any[] = [];

        let witnessAccSource = withWitnessPub ? cache.witnesses : cache.accounts;

        if (!witnessAccSource || Object.keys(witnessAccSource).length === 0) {
            logger.warn('[generateWitnesses] witnessAccSource is empty or undefined.');
        }
        for (const key in witnessAccSource) {
            // Ensure the account actually exists in the main cache.accounts map
            // and has the necessary properties before proceeding.
            const account = cache.accounts[key];
            if (!account) {
                logger.warn(`[generateWitnesses] Account not found in cache.accounts for key: ${key}`);
                continue;
            }

            if (!account.totalVoteWeight || account.totalVoteWeight <= 0) {
                logger.debug(`[generateWitnesses] Skipping account ${key} due to zero or missing totalVoteWeight: ${account.totalVoteWeight}`);
                continue;
            }
            // If we need witnessPublicKey (for witness schedule), ensure it exists.
            if (withWitnessPub && !account.witnessPublicKey) {
                logger.debug(`[generateWitnesses] Skipping account ${key} due to missing witnessPublicKey (withWitnessPub is true).`);
                continue;
            }


            let witnessDetails: any = {
                name: account.name,
                pub: account.witnessPublicKey,
                witnessPublicKey: account.witnessPublicKey,
                balance: account.tokens?.ECH || 0,
                votedWitnesses: account.votedWitnesses,
                totalVoteWeight: account.totalVoteWeight,
            };
            if (withWs && account.json && account.json.node && typeof account.json.node.ws === 'string') {
                witnessDetails.ws = account.json.node.ws;
            }
            witnesses.push(witnessDetails);
        }
        witnesses = witnesses.sort((a: any, b: any) => b.totalVoteWeight - a.totalVoteWeight);
        return witnesses.slice(start, limit);
    },
};

export default witnessesModule; 