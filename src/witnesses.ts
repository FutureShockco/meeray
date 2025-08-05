import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import p2p from './p2p.js';
import transaction from './transaction.js';
import { toBigInt, toDbString } from './utils/bigint.js';

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
    witnessRewards: (name: string, ts: number, cb: (dist: string) => void) => {
        cache.findOne('accounts', { name: name }, async function (err: any, account: any) {
            if (err) {
                logger.error('Error finding account for witness rewards:', err);
                return cb('0');
            }

            if (!account) {
                logger.error('Account not found for witness rewards:', name);
                return cb('0');
            }

            const reward = BigInt(config.witnessReward || 0);
            if (reward > BigInt(0)) {
                const currentBalanceStr = account.balances?.ECH || toDbString(BigInt(0));
                const currentBalanceBigInt = toBigInt(currentBalanceStr);

                const rewardBigInt = BigInt(reward);
                logger.debug(`[witnessRewards] Applying reward for ${name}: ${rewardBigInt.toString()}`);

                const newBalanceBigInt = currentBalanceBigInt + rewardBigInt;
                const newBalancePaddedString = toDbString(newBalanceBigInt);

                cache.updateOne(
                    'accounts',
                    { name: account.name },
                    { $set: { "balances.ECH": newBalancePaddedString } },
                    function (err: Error | null, result?: boolean) {
                        if (err) {
                            logger.error('Error updating account balance for rewards:', err);
                            return cb('0');
                        }

                        if (result === false) {
                            logger.warn(`[witnessRewards] cache.updateOne for ${account.name} reported no document was updated.`);
                        }

                        if (account.balances) {
                            account.balances.ECH = newBalancePaddedString;
                        } else {
                            account.balances = { ECH: newBalancePaddedString };
                        }
                        if (account.tokens && account.tokens.ECH !== undefined) {
                            delete account.tokens.ECH;
                            if (Object.keys(account.tokens).length === 0) {
                                delete account.tokens;
                            }
                        }

                        transaction.adjustWitnessWeight(account, reward, function () {
                            logger.debug(`Distributed reward (${rewardBigInt.toString()} smallest units) to witness ${name}`);
                            cb(toDbString(rewardBigInt));
                        });
                    }
                );
            } else {
                cb('0');
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
            const account = cache.accounts[key];
            if (!account) {
                logger.warn(`[generateWitnesses] Account not found in cache.accounts for key: ${key}`);
                continue;
            }

            if (!account.totalVoteWeight || account.totalVoteWeight <= 0) {
                logger.debug(`[generateWitnesses] Account ${account.name} has no totalVoteWeight or totalVoteWeight is less than or equal to 0.`);
                continue;
            }

            let witnessDetails: any = {
                name: account.name,
                pub: account.witnessPublicKey,
                witnessPublicKey: account.witnessPublicKey,
                balance: account.balances?.ECH || toDbString(BigInt(0)),
                votedWitnesses: account.votedWitnesses,
                totalVoteWeight: account.totalVoteWeight,
            };
            if (withWs && account.json && account.json.node && typeof account.json.node.ws === 'string') {
                witnessDetails.ws = account.json.node.ws;
            }
            witnesses.push(witnessDetails);
        }
        return witnesses;
    },
};
