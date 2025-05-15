// Leader/witness scheduling and rewards logic
// Migrated from chain.js

import { chain } from './chain.js';
import config from './config.js';
import cache from './cache.js';
import logger from './logger.js';
import p2p from './p2p.js';

export const witnessesModule = {
    /**
     * Generate the leader schedule for a given block.
     */
    witnessSchedule: (block: any) => {
        let hash = block.hash;
        let rand = parseInt('0x' + hash.substr(hash.length - (config.leaderShufflePrecision || 8)));
        if (p2p.recovering) logger.debug('Generating schedule... NRNG: ' + rand);
        let witnesses = witnessesModule.generateLeaders(true, false, config.witnesses, 0);
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

    /**
     * Generate the list of eligible witnesses.
     */
    generateWitnesses: (withWitnessPub: boolean, withWs: boolean, limit: number, start: number) => {
        let witnessesList: any[] = [];
        let witnessAccs = withWitnessPub ? (cache as any).witnesses : (cache as any).accounts;
        for (const key in witnessAccs) {
            if (!(cache as any).accounts[key].witnessVotes || (cache as any).accounts[key].witnessVotes <= 0)
                continue;
            if (withWitnessPub && !(cache as any).accounts[key].witnessPublicKey)
                continue;
            let witness = (cache as any).accounts[key];
            let witnessDetails: any = {
                name: witness.name,
                witnessPublicKey: witness.witnessPublicKey,
                balance: witness.balance,
                approves: witness.approves,
                witnessVotes: witness.witnessVotes,
            };
            if (withWs && witness.json && witness.json.node && typeof witness.json.node.ws === 'string')
                witnessDetails.ws = witness.json.node.ws;
            witnessesList.push(witnessDetails);
        }
        witnessesList = witnessesList.sort((a: any, b: any) => b.witnessVotes - a.witnessVotes);
        return witnessesList.slice(start, limit);
    },

    /**
     * Distribute witness rewards for block production.
     */
    witnessRewards: (name: string, ts: number, cb: (dist: number) => void) => {
        // rewards witnesses with 'free' voting power in the network
        (cache as any).findOne('accounts', { name: name }, function (err: any, account: any) {
            let newBalance = account.balance + (config.witnessReward || 0);
            // TODO: Implement GrowInt logic for vt and bw
            cb(0); // Placeholder until GrowInt and transaction logic is ported
        }, true);
    },

    generateLeaders: (withLeaderPub: boolean, withWs: boolean, limit: number, start: number) => {
        let leaders: any[] = [];
        let leaderAccs = withLeaderPub ? (cache as any).leaders : (cache as any).accounts;
        for (const key in leaderAccs) {
            if (!(cache as any).accounts[key].witnessVotes || (cache as any).accounts[key].witnessVotes <= 0)
                continue;
            if (withLeaderPub && !(cache as any).accounts[key].witnessPublicKey)
                continue;
            let leader = (cache as any).accounts[key];
            let leaderDetails: any = {
                name: leader.name,
                witnessPublicKey: leader.witnessPublicKey,
                balance: leader.balance,
                approves: leader.approves,
                witnessVotes: leader.witnessVotes,
            };
            if (withWs && leader.json && leader.json.node && typeof leader.json.node.ws === 'string')
                leaderDetails.ws = leader.json.node.ws;
            leaders.push(leaderDetails);
        }
        leaders = leaders.sort((a: any, b: any) => b.witnessVotes - a.witnessVotes);
        return leaders.slice(start, limit);
    },
};

export default witnessesModule; 