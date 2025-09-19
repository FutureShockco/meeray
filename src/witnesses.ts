import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import p2p from './p2p/index.js';
import { toBigInt, toDbString } from './utils/bigint.js';
import { adjustTokenSupply } from './utils/token.js';
import { adjustBalance } from './utils/account.js';

type VoteWeightUpdate = {
    sender: string;
    targetWitness?: string;
    isVote?: boolean;
    isUnvote?: boolean;
};

export const witnessesModule = {

    witnessSchedule: (block: any) => {
        let hash = block.hash;
        let rand = parseInt('0x' + hash.substr(hash.length - config.witnessShufflePrecision));
        if (!p2p.recovering) logger.debug('Generating schedule... NRNG: ' + rand);
        let witnesses = witnessesModule.generateWitnesses(true, config.read(block._id).witnesses, 0);
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
    witnessRewards: async (name: string, block: any): Promise<string> => {
        const account = await cache.findOnePromise('accounts', { name: name })
        const reward = BigInt(config.read(block._id).witnessReward || 0);
        if (reward > BigInt(0)) {
            const rewardBigInt = BigInt(reward);
            logger.trace(`witnessRewards: Applying reward for ${name}: ${rewardBigInt.toString()}`);
            const adjusted = await adjustBalance(account!.name!, config.nativeTokenSymbol, rewardBigInt);
            if (!adjusted) {
                logger.error(`witnessRewards: Failed to adjust balance for ${account!.name} when distributing rewards.`);
                return '0';
            }
            try {
                const success = await adjustTokenSupply(config.nativeTokenSymbol, rewardBigInt);
                if (!success) {
                    logger.error(`witnessRewards: Failed to update token supply for ${config.nativeTokenSymbol}`);
                }
                logger.trace(`witnessRewards: Distributed reward (${rewardBigInt.toString()} smallest units) to witness ${name}`);
                return toDbString(rewardBigInt);
            } catch (error) {
                logger.error(`witnessRewards: Failed to update token supply for ${config.nativeTokenSymbol}: ${error}`);
                return '0';
            }
        } else {
            return '0';
        }
    },
    generateWitnesses: (withWitnessPub: boolean, limit: number, start: number) => {
        let witnesses: any[] = [];

        let witnessAccSource = withWitnessPub ? cache.witnesses : cache.accounts;

        if (!witnessAccSource || Object.keys(witnessAccSource).length === 0) {
            logger.warn('generateWitnesses: witnessAccSource is empty or undefined.');
        }
        for (const key in witnessAccSource) {
            const account = cache.accounts[key];
            if (!account) {
                logger.warn(`generateWitnesses: Account not found in cache.accounts for key: ${key}`);
                continue;
            }

            if (!account.totalVoteWeight || account.totalVoteWeight <= 0) {
                logger.trace(`generateWitnesses: Account ${account.name} has no totalVoteWeight or totalVoteWeight is less than or equal to 0.`);
                continue;
            }

            let witnessDetails: any = {
                name: account.name,
                pub: account.witnessPublicKey,
                witnessPublicKey: account.witnessPublicKey,
                balance: account.balances?.[config.nativeTokenSymbol] || toDbString(BigInt(0)),
                votedWitnesses: account.votedWitnesses,
                totalVoteWeight: account.totalVoteWeight,
            };

            witnesses.push(witnessDetails);
        }
        return witnesses.slice(start, limit);
    },

    updateWitnessVoteWeights: async ({ sender, targetWitness, isVote, isUnvote }: VoteWeightUpdate): Promise<boolean> => {
        try {
            const senderAccount = await cache.findOnePromise('accounts', { name: sender });
            if (!senderAccount) {
                logger.error(`[witness-utils] Sender account ${sender} not found during vote weight update`);
                return false;
            }

            const balance = toBigInt(senderAccount.balances?.[config.nativeTokenSymbol] ?? "0");

            const oldVotedWitnesses: string[] = senderAccount.votedWitnesses || [];
            let newVotedWitnesses: string[] = [...oldVotedWitnesses];

            // Adjust witness list based on flags
            if (isVote && targetWitness) {
                if (!newVotedWitnesses.includes(targetWitness)) {
                    newVotedWitnesses.push(targetWitness);
                }
            } else if (isUnvote && targetWitness) {
                newVotedWitnesses = newVotedWitnesses.filter(w => w !== targetWitness);
            }

            // Compute per-witness weights
            const oldVoteWeightPerWitness = oldVotedWitnesses.length > 0
                ? balance / BigInt(oldVotedWitnesses.length)
                : BigInt(0);

            const newVoteWeightPerWitness = newVotedWitnesses.length > 0
                ? balance / BigInt(newVotedWitnesses.length)
                : BigInt(0);

            // Save updated list
            await cache.updateOnePromise('accounts', { name: sender }, {
                $set: { votedWitnesses: newVotedWitnesses }
            });

            // All affected witnesses: union of old and new
            const allAffectedWitnesses = new Set([...oldVotedWitnesses, ...newVotedWitnesses]);

            for (const witnessName of allAffectedWitnesses) {
                const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                if (!witnessAccount) {
                    logger.error(`[witness-utils] Witness account ${witnessName} not found during vote weight adjustment`);
                    continue;
                }

                let updatedVoteWeight = toBigInt(witnessAccount.totalVoteWeight || toDbString(BigInt(0)));

                // Subtract old vote weight if previously voted
                if (oldVotedWitnesses.includes(witnessName)) {
                    updatedVoteWeight -= oldVoteWeightPerWitness;
                }
                // Add new vote weight if currently voted
                if (newVotedWitnesses.includes(witnessName)) {
                    updatedVoteWeight += newVoteWeightPerWitness;
                }

                // Prevent negative vote weight
                if (updatedVoteWeight < BigInt(0)) {
                    updatedVoteWeight = BigInt(0);
                }

                logger.debug(`[witness-utils] Set ${witnessName} totalVoteWeight to ${updatedVoteWeight}`);

                await cache.updateOnePromise('accounts', { name: witnessName }, {
                    $set: { totalVoteWeight: toDbString(updatedVoteWeight) }
                });
            }

            return true;
        } catch (error: any) {
            logger.error(`[witness-utils] Error updating witness vote weights: ${error}`);
            return false;
        }
    }
};
