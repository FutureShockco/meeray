import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
import p2p, { MessageType } from './p2p.js';
import { isValidNewBlock } from './block.js';
import { signMessage } from './crypto.js';
import steem from './steem.js';

const consensus_need = 2;
const consensus_total = 3;
const consensus_threshold = consensus_need / consensus_total;

export interface Consensus {
    observer: boolean;
    validating: string[];
    processed: any[];
    queue: any[];
    finalizing: boolean;
    possBlocks: any[];
    getActiveWitnessKey: (name: string) => string | undefined;
    isActive: () => boolean;
    activeWitnesses: () => string[];
    tryNextStep: () => void;
    round: (round: number, block: any, cb?: (result: number) => void) => void;
    endRound: (round: number, block: any, roundCallback?: Function) => void;
    remoteRoundConfirm: (message: any) => void;
}

export const consensus: Consensus = {
    observer: false,
    validating: [],
    processed: [],
    queue: [],
    finalizing: false,
    possBlocks: [],
    getActiveWitnessKey: (name: string) => {
        let shuffle = chain.schedule.shuffle;
        for (let i = 0; i < shuffle.length; i++)
            if (shuffle[i].name === name)
                return shuffle[i].witnessPublicKey;
        return;
    },
    isActive: function () {
        if (this.observer) return false;
        const thPub = this.getActiveWitnessKey(process.env.STEEM_ACCOUNT!);
        if (!thPub) {
            logger.info(process.env.STEEM_ACCOUNT + ' is not elected, defaulting to observer');
            this.observer = true;
            return false;
        }
        if (process.env.WITNESS_PUBLIC_KEY !== thPub) {
            this.observer = true;
            logger.warn('Witness key does not match blockchain data, observing instead ' + thPub + ' ' + process.env.WITNESS_PUBLIC_KEY);
            return false;
        }
        return true;
    },
    activeWitnesses: function () {
        // the real active witnesses are those who can mine or backup this block
        // i.e. a new witness only enters consensus on the block he gets scheduled for
        // and out of consensus 2*config.witnesses blocks after his last scheduled block
        const blockNum = chain.getLatestBlock()._id + 1;
        const actives: string[] = [];

        let currentWitness = chain.schedule.shuffle[(blockNum - 1) % config.witnesses].name;
        if (consensus.getActiveWitnessKey(currentWitness))
            actives.push(currentWitness);

        for (let i = 1; i < 2 * config.witnesses; i++)
            if (chain.recentBlocks[chain.recentBlocks.length - i]
                && actives.indexOf(chain.recentBlocks[chain.recentBlocks.length - i].witness) === -1
                && consensus.getActiveWitnessKey(chain.recentBlocks[chain.recentBlocks.length - i].witness))
                actives.push(chain.recentBlocks[chain.recentBlocks.length - i].witness);

        return actives;
    },
    tryNextStep: function () {
        const currentChainHeadId = chain.getLatestBlock?.()._id;
        if (typeof currentChainHeadId !== 'number') {
            logger.warn("[CONSENSUS:tryNextStep] Could not get current chain head ID.");
            return;
        }
        const targetBlockId = currentChainHeadId + 1;

        const consensus_size = this.activeWitnesses().length;
        if (consensus_size === 0) {
            logger.warn("[CONSENSUS:tryNextStep] No active witnesses found. Consensus cannot proceed.");
            return;
        }
        let threshold = consensus_size * consensus_threshold;
        if (!this.isActive()) threshold += 1; // Observer nodes need one more confirmation

        // Filter for blocks at the target height that have enough final round confirmations
        let candidatePossBlocks = this.possBlocks.filter(pb => 
            pb.block._id === targetBlockId &&
            pb[(config.consensusRounds || 2) - 1].length > threshold
        );

        if (candidatePossBlocks.length === 0) {
            // No block meets the criteria yet.
            // Still need to process other rounds for blocks that might become candidates later.
            for (let i = 0; i < this.possBlocks.length; i++) {
                const possBlock = this.possBlocks[i];
                if (possBlock.block._id === targetBlockId) { // Only consider for current height
                    for (let y = 0; y < (config.consensusRounds || 2) - 1; y++) { // Iterate through non-final rounds
                        if (possBlock[y].length > threshold && // If a non-final round has enough confirmations
                           this.isActive() && // Only active witnesses should try to advance rounds this way
                           possBlock[y+1].indexOf(process.env.STEEM_ACCOUNT || '') === -1 ) { // And this node hasn't confirmed the *next* round yet for this block
                            this.round(y + 1, possBlock.block);
                        }
                    }
                }
            }
            return;
        }

        // If there are candidates, sort them to pick the winner
        candidatePossBlocks.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp) {
                return a.block.timestamp - b.block.timestamp; // Oldest timestamp first
            }
            return a.block.hash < b.block.hash ? -1 : 1; // Smallest hash first for tie-breaking
        });

        const winningPossBlock = candidatePossBlocks[0]; // The first one after sorting is the winner

        if (!this.finalizing) { // Ensure we only attempt to finalize one block at a time
            this.finalizing = true;
            
            let possBlocksByIdForLogging: Record<string, any[]> = {};
            if (this.possBlocks.length > 1) {
                 for (let pb of this.possBlocks) {
                     const blockId = pb.block._id;
                     if (blockId === targetBlockId) { 
                        if (possBlocksByIdForLogging[blockId]) {
                            possBlocksByIdForLogging[blockId].push(pb);
                        } else {
                            possBlocksByIdForLogging[blockId] = [pb];
                        }
                     }
                 }
            }

            if (possBlocksByIdForLogging[targetBlockId] && possBlocksByIdForLogging[targetBlockId].length > 1) {
                let collisions = possBlocksByIdForLogging[targetBlockId].map(pb => [pb.block.witness, pb.block.timestamp, pb.block.hash.substr(0,4)]);
                logger.warn(`Block collision detected at height ${targetBlockId}, proposals considered:`, collisions);
                logger.warn(`Winning block chosen by deterministic sort: ${targetBlockId}#${winningPossBlock.block.hash.substr(0, 4)} by ${winningPossBlock.block.witness} with timestamp ${winningPossBlock.block.timestamp}`);
            } else {
                logger.debug(`Block ${targetBlockId}#${winningPossBlock.block.hash.substr(0, 4)} got finalized by ${winningPossBlock.block.witness}`);
            }

            chain.validateAndAddBlock(winningPossBlock.block, false, (err: any) => {
                if (err) {
                    logger.error(`[CONSENSUS-TRYSTEP] Error validating/adding winning block ${winningPossBlock.block?._id}:`, err);
                }
                this.possBlocks = this.possBlocks.filter(pb => pb.block._id > winningPossBlock.block._id);
                this.finalizing = false;
                if(this.queue.length > 0 || this.possBlocks.length > 0) {
                     // Use setTimeout to avoid potential deep recursion if tryNextStep leads to another immediate finalization
                    setTimeout(() => this.tryNextStep(), 0); 
                }
            });
        }
    },
    round: function (round: number, block: any, cb?: (result: number) => void) {
        if (block._id && block._id !== chain.getLatestBlock?.()._id + 1) {
            if (cb) cb(-1);
            return;
        }
        if (block.hash === chain.getLatestBlock?.().hash) {
            if (cb) cb(-1);
            return;
        }
        if (round === 0) {
            for (let i = 0; i < this.possBlocks.length; i++)
                if (this.possBlocks[i].block.hash === block.hash) {
                    if (cb) cb(1);
                    return;
                }

            if (this.validating.indexOf(block.hash) > -1) {
                if (cb) cb(0);
                return;
            }
            if (Object.keys(block).length === 1 && block.hash) {
                if (cb) cb(0);
                return;
            }

            this.validating.push(block.hash);

            let possBlock: any = { block };

            for (let r = 0; r < config.consensusRounds; r++)
                possBlock[r] = [];
            logger.debug('New poss block ' + block._id + '/' + block.witness + '/' + block.hash.substr(0, 4));
            isValidNewBlock(block, true, true, (isValid: boolean) => {
                this.validating.splice(this.validating.indexOf(possBlock.block.hash), 1);
                if (!isValid) {
                    logger.error('Received invalid new block from ' + block.witness, block.hash);
                    if (cb) cb(-1);
                } else {
                    logger.debug('Precommitting block ' + block._id + '#' + block.hash.substr(0, 4));

                    this.possBlocks.push(possBlock);

                    for (let i = 0; i < this.possBlocks.length; i++)
                        if (block.hash === this.possBlocks[i].block.hash && this.possBlocks[i][0].indexOf(process.env.STEEM_ACCOUNT) === -1) {
                            possBlock[0].push(process.env.STEEM_ACCOUNT);
                        }
                    for (let i = 0; i < this.queue.length; i++) {
                        if (this.queue[i].d.b.hash === possBlock.block.hash) {
                            this.remoteRoundConfirm(this.queue[i]);
                            this.queue.splice(i, 1);
                            i--;
                            continue;
                        }
                        const blockTime = steem.isInSyncMode() ? config.syncBlockTime : config.blockTime;
                        if (this.queue[i].d.ts + 2 * blockTime < new Date().getTime()) {
                            this.queue.splice(i, 1);
                            i--;
                        }
                    }
                    this.endRound(round, block);
                    if (cb) cb(1);
                }
            });
        } else {
            for (let b = 0; b < this.possBlocks.length; b++)
                if (this.possBlocks[b].block.hash === block.hash && this.possBlocks[b][round].indexOf(process.env.STEEM_ACCOUNT) === -1) {
                    this.possBlocks[b][round].push(process.env.STEEM_ACCOUNT);
                    this.endRound(round, block);
                }
        }
    },
    endRound: function (round: number, block: any, roundCallback?: Function) {
        if (this.isActive()) {
            let onlyBlockHash: any = { hash: block.hash };
            if (block.witness === process.env.STEEM_ACCOUNT && round === 0)
                onlyBlockHash = block;
            let signed = signMessage({ t: MessageType.BLOCK_CONF_ROUND, d: { r: round, b: onlyBlockHash, ts: new Date().getTime() } })
            p2p.broadcast(signed);
        }
        this.tryNextStep();
    },
    remoteRoundConfirm: function (message: any) {
        const block = message.d.b;
        const round = message.d.r;
        const witness = message.s.n;
        for (let i = 0; i < this.possBlocks.length; i++) {
            if (block.hash === this.possBlocks[i].block.hash) {
                if (this.possBlocks[i][round] && this.possBlocks[i][round].indexOf(witness) === -1) {
                    for (let r = round; r >= 0; r--)
                        if (this.possBlocks[i][r].indexOf(witness) === -1)
                            this.possBlocks[i][r].push(witness);
                    this.tryNextStep();
                }
                break;
            }
        }
    },
};

export default consensus; 