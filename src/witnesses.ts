import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import p2p from './p2p/index.js';
import { toBigInt, toDbString } from './utils/bigint.js';
import { adjustTokenSupply } from './utils/token.js';
import { adjustUserBalance } from './utils/account.js';

type VoteWeightUpdate = {
    sender: string;
    balance: bigint;
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
        const reward = toBigInt(config.read(block._id).witnessReward || 0);
        if (account && account.name && reward > toBigInt(0)) {
            const rewardBigInt = toBigInt(reward);
            logger.trace(`witnessRewards: Applying reward for ${name}: ${rewardBigInt.toString()}`);
            const adjusted = await adjustUserBalance(account.name, config.nativeTokenSymbol, rewardBigInt);
            if (!adjusted) {
                logger.error(`witnessRewards: Failed to adjust balance for ${account!.name} when distributing rewards.`);
                return '0';
            }
            try {
                const success = await adjustTokenSupply(config.nativeTokenSymbol, rewardBigInt);
                if (success === null) {
                    logger.error(`witnessRewards: Failed to update token supply for ${config.nativeTokenSymbol}`);
                    return '0';
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
                balance: account.balances?.[config.nativeTokenSymbol] || toDbString(toBigInt(0)),
                votedWitnesses: account.votedWitnesses,
                totalVoteWeight: account.totalVoteWeight,
            };

            witnesses.push(witnessDetails);
        }
        return witnesses.slice(start, limit);
    },
    updateWitnessVoteWeights: async ({
        sender,
        balance,
        targetWitness,
        isVote,
        isUnvote
    }: VoteWeightUpdate): Promise<boolean> => {
        try {
            const senderAccount = await cache.findOnePromise('accounts', { name: sender });
            if (!senderAccount) {
                logger.error(`[witness-utils] Sender account ${sender} not found`);
                return false;
            }

            const oldVotedWitnesses: string[] = senderAccount.votedWitnesses || [];
            let newVotedWitnesses: string[] = [...oldVotedWitnesses];

            // --- Adjust voted witnesses based on vote/unvote ---
            if (isVote && targetWitness && !newVotedWitnesses.includes(targetWitness)) {
                newVotedWitnesses.push(targetWitness);
            } else if (isUnvote && targetWitness) {
                newVotedWitnesses = newVotedWitnesses.filter(w => w !== targetWitness);
            }

            // Save updated voted list
            await cache.updateOnePromise('accounts', { name: sender }, {
                $set: { votedWitnesses: newVotedWitnesses }
            });

            // --- Determine balances ---
            const currentBalance = balance !== undefined
                ? balance
                : toBigInt(senderAccount.balances?.[config.nativeTokenSymbol] || 0n);

            const oldBalance = senderAccount.previousBalance !== undefined
                ? toBigInt(senderAccount.previousBalance)
                : currentBalance;

            // --- Compute per-witness shares ---
            const oldShare = oldVotedWitnesses.length > 0 ? oldBalance / toBigInt(oldVotedWitnesses.length) : 0n;
            const newShare = newVotedWitnesses.length > 0 ? currentBalance / toBigInt(newVotedWitnesses.length) : 0n;

            const deltaMap: Map<string, bigint> = new Map();

            // Subtract old share from old witnesses (only if votes changed)
            if (JSON.stringify(oldVotedWitnesses) !== JSON.stringify(newVotedWitnesses)) {
                for (const w of oldVotedWitnesses) {
                    deltaMap.set(w, (deltaMap.get(w) || 0n) - oldShare);
                }
            }

            // Add delta per witness based on balance change
            for (const w of newVotedWitnesses) {
                const delta = newShare - oldShare;
                deltaMap.set(w, (deltaMap.get(w) || 0n) + delta);
            }

            // --- Apply deltas ---
            for (const [witnessName, delta] of deltaMap.entries()) {
                if (delta === 0n) continue;

                const witnessAccount = await cache.findOnePromise('accounts', { name: witnessName });
                if (!witnessAccount) continue;

                let currentVoteWeight = toBigInt(witnessAccount.totalVoteWeight || 0n);
                currentVoteWeight += delta;
                if (currentVoteWeight < 0n) currentVoteWeight = 0n;

                await cache.updateOnePromise('accounts', { name: witnessName }, {
                    $set: { totalVoteWeight: toDbString(currentVoteWeight) }
                });

                logger.info(`[witness-utils] Updated ${witnessName} totalVoteWeight: ${currentVoteWeight}`);
            }

            // --- Handle unassigned balance for accounts with no votes ---
            if (newVotedWitnesses.length === 0) {
                await cache.updateOnePromise('accounts', { name: sender }, {
                    $set: { unassignedVoteWeight: toDbString(currentBalance) }
                });
                logger.info(`[witness-utils] Updated ${sender} unassignedVoteWeight: ${currentBalance}`);
            } else {
                // Clear unassigned weight if there are votes
                await cache.updateOnePromise('accounts', { name: sender }, {
                    $unset: { unassignedVoteWeight: "" }
                });
            }

            return true;
        } catch (error: any) {
            logger.error(`[witness-utils] Error updating witness vote weights: ${error}`);
            return false;
        }
    }
};