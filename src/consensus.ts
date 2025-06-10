import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
import p2p, { MessageType } from './p2p.js';
import { isValidNewBlock } from './block.js';
import { signMessage } from './crypto.js';
import steem from './steem.js';
import mining from './mining.js';

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
    handleSyncCollisionWithNetworkQuery: (collisionHeight: number, collisions: any[], savedPossBlocks: any[]) => void;
    rejectCollisionAndWait: (collisionHeight: number) => void;
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
            //logger.cons('T'+Math.ceil(threshold)+' R0-'+possBlock[0].length+' R1-'+possBlock[1].length)
            if (
                possBlock[(config.consensusRounds || 2) - 1].length > threshold &&
                !this.finalizing &&
                possBlock.block._id === chain.getLatestBlock?.()._id + 1
                // && possBlock[0] && possBlock[0].indexOf(process.env.STEEM_ACCOUNT) !== -1 // Temporarily commented out for testing churn
            ) {
                this.finalizing = true;
                
                // In sync mode, add a grace period for potential collisions (all blocks)
                if (steem.isInSyncMode() && !p2p.recovering) {
                    const hasCollision = possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1;
                    
                    if (!hasCollision) {
                        // No collision detected yet - wait briefly for competing blocks to arrive
                        const isOurBlock = possBlock.block.witness === process.env.STEEM_ACCOUNT;
                        const blockSource = isOurBlock ? "our mined" : "received";
                        logger.debug(`[SYNC-GRACE] Block ${possBlock.block._id} (${blockSource}) waiting for collision detection`);
                        this.finalizing = false; // Reset to allow collision detection
                        
                        setTimeout(() => {
                            // Re-check for collision after grace period
                            const stillNoCollision = !possBlocksById[possBlock.block._id] || possBlocksById[possBlock.block._id].length <= 1;
                            if (stillNoCollision && !this.finalizing) {
                                logger.debug(`[SYNC-GRACE] No collision after grace period. Finalizing block ${possBlock.block._id} (${blockSource})`);
                                this.finalizing = true;
                                this.tryNextStep(); // Re-trigger consensus
                            }
                        }, 150); // 150ms grace period for all blocks in sync mode
                        return;
                    }
                }
                
                // log which block got applied if collision exists
                if (possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1) {
                    let collisions = [];
                    for (let j = 0; j < possBlocksById[possBlock.block._id].length; j++)
                        collisions.push([
                            possBlocksById[possBlock.block._id][j].block.witness,
                            possBlocksById[possBlock.block._id][j].block.timestamp,
                        ]);
                    logger.warn('Block collision detected at height ' + possBlock.block._id + ', the witnesses are:', collisions);
                    
                    // In sync mode, use deterministic collision resolution
                    if (steem.isInSyncMode() && !p2p.recovering) {
                        logger.info(`[SYNC-COLLISION] Detected ${collisions.length} colliding blocks at height ${possBlock.block._id}. Using deterministic resolution...`);
                        
                        // Find the winning block using deterministic criteria
                        let winningBlock = possBlock;
                        for (const collidingPossBlock of possBlocksById[possBlock.block._id]) {
                            const currentBlock = collidingPossBlock.block;
                            const winningBlockData = winningBlock.block;
                            
                            // Primary: Earliest timestamp wins
                            if (currentBlock.timestamp < winningBlockData.timestamp) {
                                winningBlock = collidingPossBlock;
                            } 
                            // Tie-breaker: Lexicographically smallest hash wins
                            else if (currentBlock.timestamp === winningBlockData.timestamp && 
                                     currentBlock.hash < winningBlockData.hash) {
                                winningBlock = collidingPossBlock;
                            }
                        }
                        
                        // If this isn't the winning block, remove it and wait for the winner
                        if (possBlock.block.hash !== winningBlock.block.hash) {
                            logger.info(`[SYNC-COLLISION] Block ${possBlock.block._id} by ${possBlock.block.witness} lost collision. Winner: ${winningBlock.block.witness} (timestamp: ${winningBlock.block.timestamp})`);
                            
                            // Remove losing blocks from consideration
                            let newPossBlocks = [];
                            for (let y = 0; y < this.possBlocks.length; y++) {
                                if (this.possBlocks[y].block.hash !== possBlock.block.hash) {
                                    newPossBlocks.push(this.possBlocks[y]);
                                }
                            }
                            this.possBlocks = newPossBlocks;
                            this.finalizing = false; // Reset and wait for winning block
                            return;
                        }
                        
                        logger.info(`[SYNC-COLLISION] Block ${possBlock.block._id} by ${possBlock.block.witness} won collision (timestamp: ${possBlock.block.timestamp})`);
                        // Continue with processing the winning block
                    }
                    
                    // In normal mode, apply the winning block as before
                    logger.info('Applying block ' + possBlock.block._id + '#' + possBlock.block.hash.substr(0, 4) + ' by ' + possBlock.block.witness + ' with timestamp ' + possBlock.block.timestamp);
                    
                    // Store alternative blocks for sync reconciliation (diagnostic only now)
                    const alternativeBlocks = possBlocksById[possBlock.block._id].filter(pb => pb.block.hash !== possBlock.block.hash);
                    if (alternativeBlocks.length > 0) {
                        logger.info(`[COLLISION-TRACKING] Storing ${alternativeBlocks.length} alternative blocks for height ${possBlock.block._id} for diagnostics`);
                        
                        for (const altBlock of alternativeBlocks) {
                            // Security check: Only store blocks that passed basic validation
                            if (!altBlock.block.hash || !altBlock.block.witness || !altBlock.block.signature) {
                                logger.warn(`[COLLISION-TRACKING] Skipping invalid alternative block from ${altBlock.block.witness}`);
                                continue;
                            }
                            
                            // Add alternative blocks for diagnostic purposes
                            const tempBlock = { 
                                ...altBlock.block, 
                                _isAlternative: true,
                                _storedAt: Date.now() // Timestamp for cleanup
                            };
                            
                            // Store in a way that can be referenced but doesn't interfere with main chain
                            if (!chain.alternativeBlocks) chain.alternativeBlocks = [];
                            chain.alternativeBlocks.push(tempBlock);
                            
                            // Enhanced memory management: Keep only recent alternatives
                            const maxAlternatives = 25;
                            const maxAge = 300000; // 5 minutes max age
                            const now = Date.now();
                            
                            // Clean by both count and age
                            chain.alternativeBlocks = chain.alternativeBlocks.filter(ab => 
                                now - ab._storedAt < maxAge && // Remove old blocks
                                ab._id >= possBlock.block._id - 10 // Keep only last 10 block heights
                            ).slice(-maxAlternatives); // Keep only last N blocks
                        }
                    }
                } else {
                    logger.debug('block ' + possBlock.block._id + '#' + possBlock.block.hash.substr(0, 4) + ' got finalized');
                }
                chain.validateAndAddBlock(possBlock.block, false, (err: any) => {
                    if (err) {
                        logger.error(`[CONSENSUS-TRYSTEP] Error for block ${possBlock.block?._id}:`, err);
                    }
                    let newPossBlocks = [];
                    for (let y = 0; y < this.possBlocks.length; y++)
                        if (possBlock.block._id < this.possBlocks[y].block._id)
                            newPossBlocks.push(this.possBlocks[y]);
                    this.possBlocks = newPossBlocks;
                    this.finalizing = false; // Reset finalizing status here.
                });
            }
            else for (let y = 0; y < (config.consensusRounds || 2) - 1; y++)
                if (possBlock[y].length > threshold)
                    this.round(y + 1, possBlock.block);
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
                        if (this.queue[i].d.ts + 2 * config.blockTime < new Date().getTime()) {
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
    
    handleSyncCollisionWithNetworkQuery: function (collisionHeight: number, collisions: any[], savedPossBlocks: any[]) {
        logger.debug(`[SYNC-COLLISION] Querying network consensus for collision at height ${collisionHeight}`);
        
        // Query peer head blocks to see if majority advanced
        const peersWithStatus = p2p.sockets.filter(ws => 
            ws.node_status && 
            ws.node_status.head_block !== undefined &&
            ws.node_status.origin_block === config.read(0).originHash
        );
        
        if (peersWithStatus.length === 0) {
            logger.warn(`[SYNC-COLLISION] No peers available for consensus query. Defaulting to collision rejection.`);
            this.rejectCollisionAndWait(collisionHeight);
            return;
        }
        
        // Check if majority of peers advanced beyond collision height
        const peersAdvanced = peersWithStatus.filter(ws => ws.node_status!.head_block > collisionHeight);
        const majorityThreshold = Math.ceil(peersWithStatus.length / 2);
        
        if (peersAdvanced.length >= majorityThreshold) {
            logger.info(`[SYNC-COLLISION] Network majority (${peersAdvanced.length}/${peersWithStatus.length}) advanced past collision. Requesting winning block.`);
            
            // Find the most common head block among advanced peers
            const headBlocks: { [key: number]: number } = {};
            peersAdvanced.forEach(ws => {
                const headBlock = ws.node_status!.head_block;
                headBlocks[headBlock] = (headBlocks[headBlock] || 0) + 1;
            });
            
            const winningHeight = Object.keys(headBlocks).map(Number).reduce((a, b) => 
                headBlocks[a] > headBlocks[b] ? a : b
            );
            
            // Request the winning block for collision height
            logger.info(`[SYNC-COLLISION] Requesting block ${collisionHeight} from peer with head ${winningHeight}`);
            const championPeer = peersAdvanced.find(ws => ws.node_status!.head_block >= winningHeight);
            if (championPeer) {
                p2p.sendJSON(championPeer, { t: MessageType.QUERY_BLOCK, d: collisionHeight });
            }
        } else {
            logger.info(`[SYNC-COLLISION] Network majority (${peersWithStatus.length - peersAdvanced.length}/${peersWithStatus.length}) did not advance. Proceeding with collision rejection.`);
            this.rejectCollisionAndWait(collisionHeight);
        }
    },
    
    rejectCollisionAndWait: function (collisionHeight: number) {
        logger.info(`[SYNC-COLLISION] Rejecting all colliding blocks at height ${collisionHeight}. Chain head unchanged.`);
        
        // Remove all blocks at collision height from consideration
        let newPossBlocks = [];
        for (let y = 0; y < this.possBlocks.length; y++) {
            if (this.possBlocks[y].block._id !== collisionHeight) {
                newPossBlocks.push(this.possBlocks[y]);
            }
        }
        this.possBlocks = newPossBlocks;
        
        logger.info(`[SYNC-COLLISION] Chain head remains at ${chain.getLatestBlock()._id}#${chain.getLatestBlock().hash.substr(0, 4)}. Next witness can mine cleanly.`);
    },
};

export default consensus; 