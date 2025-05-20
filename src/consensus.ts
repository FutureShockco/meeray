import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
import p2p, { MessageType } from './p2p.js';
import baseX from 'base-x';
import { isValidNewBlock } from './block.js';
import { signMessage } from './crypto.js';
import steem from './steem.js';
const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

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
        // the real active leaders are those who can mine or backup this block
        // i.e. a new leader only enters consensus on the block he gets scheduled for
        // and out of consensus 2*config.leaders blocks after his last scheduled block
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
        const consensus_size = this.activeWitnesses().length;
        let threshold = consensus_size * consensus_threshold;
        if (!this.isActive()) threshold += 1;
        let possBlocksById: Record<string, any[]> = {};
        if (this.possBlocks.length > 1) {
            for (let i = 0; i < this.possBlocks.length; i++) {
                const blockId = this.possBlocks[i].block._id;
                if (possBlocksById[blockId])
                    possBlocksById[blockId].push(this.possBlocks[i]);
                else
                    possBlocksById[blockId] = [this.possBlocks[i]];
            }
            this.possBlocks.sort((a, b) => {
                if (a.block.timestamp !== b.block.timestamp)
                    return a.block.timestamp - b.block.timestamp;
                else
                    return a.block.hash < b.block.hash ? -1 : 1;
            });
        }
        for (let i = 0; i < this.possBlocks.length; i++) {
            const possBlock = this.possBlocks[i];
            // logger.cons('T'+Math.ceil(threshold)+' R0-'+possBlock[0].length+' R1-'+possBlock[1].length)
            if (
                possBlock[(config.consensusRounds || 2) - 1].length > threshold &&
                !this.finalizing &&
                possBlock.block._id === chain.getLatestBlock?.()._id + 1 &&
                possBlock[0] && possBlock[0].indexOf(process.env.STEEM_ACCOUNT) !== -1
            ) {
                this.finalizing = true;
                if (possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1) {
                    let collisions = [];
                    for (let j = 0; j < possBlocksById[possBlock.block._id].length; j++)
                        collisions.push([
                            possBlocksById[possBlock.block._id][j].block.witness,
                            possBlocksById[possBlock.block._id][j].block.timestamp,
                        ]);
                    logger.info('Block collision detected at height ' + possBlock.block._id + ', the witnesses are:', collisions);
                    logger.info('Applying block ' + possBlock.block._id + '#' + possBlock.block.hash.substr(0, 4) + ' by ' + possBlock.block.witness + ' with timestamp ' + possBlock.block.timestamp);
                } else {
                    logger.info('block ' + possBlock.block._id + '#' + possBlock.block.hash.substr(0, 4) + ' got finalized');
                }
                chain.validateAndAddBlock(possBlock.block, false, (err: any) => {
                    if (err) {
                        logger.error(`[CONSENSUS-TRYSTEP] Error from validateAndAddBlock for block ${possBlock.block?._id}:`, err);
                    }
                    let newPossBlocks = [];
                    for (let y = 0; y < this.possBlocks.length; y++)
                        if (possBlock.block._id < this.possBlocks[y].block._id)
                            newPossBlocks.push(this.possBlocks[y]);
                    this.possBlocks = newPossBlocks;
                    this.finalizing = false; // Reset finalizing status here.
                });
            } else {
                for (let y = 0; y < (config.consensusRounds || 2) - 1; y++)
                    if (possBlock[y].length > threshold)
                        this.round(y + 1, possBlock.block);
            }
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
            logger.info('New poss block ' + block._id + '/' + block.witness + '/' + block.hash.substr(0, 4));
            isValidNewBlock(block, true, true, (isValid: boolean) => {
                this.validating.splice(this.validating.indexOf(possBlock.block.hash), 1);
                if (!isValid) {
                    logger.error('Received invalid new block from ' + block.witness, block.hash);
                    if (cb) cb(-1);
                } else {
                    logger.info('Precommitting block ' + block._id + '#' + block.hash.substr(0, 4));

                    this.possBlocks.push(possBlock);

                    for (let i = 0; i < this.possBlocks.length; i++)
                        if (block.hash === this.possBlocks[i].block.hash && this.possBlocks[i][0].indexOf(process.env.STEEM_ACCOUNT) === -1) {
                            possBlock[0].push(process.env.STEEM_ACCOUNT);
                        }
                    for (let i = 0; i < this.queue.length; i++) {
                        if (this.queue[i].d.b.hash === possBlock.block.hash) {
                            logger.warn('From Queue: ' + consensus.queue[i].d.b.hash)
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