import { isValidNewBlock } from './block.js';
import { chain } from './chain.js';
import config from './config.js';
import { signMessage } from './crypto.js';
import logger from './logger.js';
import p2p, { MessageType } from './p2p/index.js';
import steem from './steem.js';

const consensus_need = 2;
const consensus_total = 3;

// Sync mode collision detection window - 200ms
const SYNC_COLLISION_WINDOW_MS = 200;
const syncCollisionTimers: { [height: number]: any } = {};
const syncPendingBlocks: { [height: number]: any[] } = {};

export interface Consensus {
    observer: boolean;
    validating: string[];
    processed: any[];
    queue: any[];
    finalizing: boolean;
    possBlocks: any[];
    witnessLastSeen?: Map<string, number>;
    getConsensus: () => {
        consensus_need: number;
        consensus_total: number;
        consensus_threshold: number;
        consensus_active: number;
        consensus_size: number;
        consensus_is_met: boolean;
    };
    getActiveWitnessKey: (name: string) => string | undefined;
    isActive: () => boolean;
    activeWitnesses: () => string[];
    tryNextStep: () => void;
    round: (round: number, block: any, cb?: (result: number) => void) => void;
    processBlockNormally: (round: number, block: any, cb?: (result: number) => void) => void;
    endRound: (round: number, block: any, roundCallback?: Function) => void;
    remoteRoundConfirm: (message: any) => void;
    handleSyncCollisionWithNetworkQuery: (collisionHeight: number, collisions: any[], savedPossBlocks: any[]) => void;
    rejectCollisionAndWait: (collisionHeight: number) => void;
}

// Function to process collected blocks after collision window
const processSyncCollisionWindow = (height: number) => {
    const pendingBlocks = syncPendingBlocks[height];
    if (!pendingBlocks || pendingBlocks.length === 0) {
        logger.warn(`[SYNC-COLLISION-WINDOW] No pending blocks for height ${height}`);
        return;
    }

    // Check if this block height has already been processed (chain already advanced)
    const currentChainHead = chain.getLatestBlock()._id;
    if (currentChainHead >= height) {
        logger.debug(
            `[SYNC-COLLISION-WINDOW] Block height ${height} already processed (chain head: ${currentChainHead}). Skipping collision window.`
        );
        // Cleanup and return
        delete syncCollisionTimers[height];
        delete syncPendingBlocks[height];
        return;
    }

    // Debug: Log all pending blocks to help troubleshoot
    for (let i = 0; i < pendingBlocks.length; i++) {
        const block = pendingBlocks[i].block;
        logger.debug(
            `[SYNC-COLLISION-WINDOW] Block ${i}: height=${block?._id || 'unknown'}, witness=${block?.witness || 'unknown'}, timestamp=${block?.timestamp || 'unknown'}, hash=${block?.hash?.substr(0, 8) || 'unknown'}`
        );
    }

    if (pendingBlocks.length === 1) {
        // Only one block - process normally
        const block = pendingBlocks[0].block;
        const cb = pendingBlocks[0].cb;
        consensus.processBlockNormally(0, block, cb);
    } else {
        // Multiple blocks - apply deterministic resolution
        logger.info(
            `[SYNC-COLLISION-WINDOW] Collision detected for height ${height} with ${pendingBlocks.length} blocks. Applying deterministic resolution.`
        );

        // Sort by timestamp first, then by hash for deterministic ordering
        pendingBlocks.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp) {
                return a.block.timestamp - b.block.timestamp;
            }
            return a.block.hash < b.block.hash ? -1 : 1;
        });

        const winningBlock = pendingBlocks[0];

        // Log the losing blocks
        for (let i = 1; i < pendingBlocks.length; i++) {
            const losingBlock = pendingBlocks[i];
            logger.debug(
                `[SYNC-COLLISION-WINDOW] Rejected: Block ${height} by ${losingBlock.block?.witness || 'unknown'} (timestamp: ${losingBlock.block?.timestamp || 'unknown'})`
            );
        }

        // Process the winning block
        consensus.processBlockNormally(0, winningBlock.block, winningBlock.cb);
    }
};

export const consensus: Consensus = {
    observer: false,
    validating: [],
    processed: [],
    queue: [],
    finalizing: false,
    possBlocks: [],
    getActiveWitnessKey: (name: string) => {
        const shuffle = chain.schedule.shuffle;
        for (let i = 0; i < shuffle.length; i++) if (shuffle[i].name === name) return shuffle[i].witnessPublicKey;
        return;
    },
    getConsensus: () => {
        const consensus_size = consensus.activeWitnesses().length;
        const consensus_threshold = consensus_need / consensus_total;
        const consensus_active = consensus_size * consensus_threshold;
        const consensus_is_met = consensus_size / consensus_active >= consensus_threshold;
        return {
            consensus_need,
            consensus_total,
            consensus_threshold,
            consensus_active,
            consensus_size,
            consensus_is_met,
        };
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
            logger.warn(
                'Witness key does not match blockchain data, observing instead ' + thPub + ' ' + process.env.WITNESS_PUBLIC_KEY
            );
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
        const currentTime = Date.now();
        const witnessTimeoutMs = config.blockTime * 4; // Consider witness offline after 4 block times without activity

        // Track when we last saw each witness be active (mining or confirming)
        if (!consensus.witnessLastSeen) {
            consensus.witnessLastSeen = new Map<string, number>();
        }

        const currentWitness = chain.schedule.shuffle[(blockNum - 1) % config.witnesses].name;
        const currentWitnessKey = consensus.getActiveWitnessKey(currentWitness);
        logger.debug(
            `[DEBUG-ACTIVE-WITNESSES] Current witness for block ${blockNum}: ${currentWitness}, hasKey: ${!!currentWitnessKey}`
        );

        // Only add current witness if they have a key and haven't timed out
        if (currentWitnessKey) {
            const lastSeen = consensus.witnessLastSeen.get(currentWitness) || currentTime;
            const timeSinceLastSeen = currentTime - lastSeen;

            if (timeSinceLastSeen <= witnessTimeoutMs) {
                actives.push(currentWitness);
                logger.debug(
                    `[DEBUG-ACTIVE-WITNESSES] Added current witness ${currentWitness} (last seen ${timeSinceLastSeen}ms ago)`
                );
            } else {
                logger.debug(
                    `[DEBUG-ACTIVE-WITNESSES] Excluding timed out current witness ${currentWitness} (last seen ${timeSinceLastSeen}ms ago, timeout: ${witnessTimeoutMs}ms)`
                );
            }
        }

        for (let i = 1; i < 2 * config.witnesses; i++) {
            const recentBlock = chain.recentBlocks[chain.recentBlocks.length - i];
            if (recentBlock) {
                const witnessKey = consensus.getActiveWitnessKey(recentBlock.witness);
                const alreadyAdded = actives.indexOf(recentBlock.witness) !== -1;

                if (!alreadyAdded && witnessKey) {
                    // Update last seen time for this witness based on when they mined this block
                    consensus.witnessLastSeen.set(recentBlock.witness, recentBlock.timestamp);

                    const timeSinceLastSeen = currentTime - recentBlock.timestamp;

                    if (timeSinceLastSeen <= witnessTimeoutMs) {
                        actives.push(recentBlock.witness);
                        logger.debug(
                            `[DEBUG-ACTIVE-WITNESSES] Added recent witness ${recentBlock.witness} (last seen ${timeSinceLastSeen}ms ago)`
                        );
                    } else {
                        logger.debug(
                            `[DEBUG-ACTIVE-WITNESSES] Excluding timed out witness ${recentBlock.witness} (last seen ${timeSinceLastSeen}ms ago, timeout: ${witnessTimeoutMs}ms)`
                        );
                    }
                }
            }
        }

        // Also track witnesses who have recently sent confirmations (from P2P messages)
        // This will be updated in remoteRoundConfirm
        for (const [witness, lastSeenTime] of consensus.witnessLastSeen.entries()) {
            const timeSinceLastSeen = currentTime - lastSeenTime;
            const alreadyAdded = actives.indexOf(witness) !== -1;
            const witnessKey = consensus.getActiveWitnessKey(witness);

            if (!alreadyAdded && witnessKey && timeSinceLastSeen <= witnessTimeoutMs) {
                actives.push(witness);
                logger.debug(
                    `[DEBUG-ACTIVE-WITNESSES] Added witness ${witness} based on recent P2P activity (last seen ${timeSinceLastSeen}ms ago)`
                );
            }
        }

        logger.debug(`[DEBUG-ACTIVE-WITNESSES] Final active witnesses: [${actives.join(',')}] (count: ${actives.length})`);
        return actives;
    },
    tryNextStep: function () {
        const { consensus_threshold, consensus_size } = this.getConsensus();
        let threshold = consensus_size * consensus_threshold;
        if (!this.isActive()) threshold += 1;
        logger.debug(
            `consensus.tryNextStep: consensus_size=${consensus_size}, threshold=${threshold}, consensus_threshold=${consensus_threshold}, isActive=${this.isActive()}`
        );
        const possBlocksById: Record<string, any[]> = {};

        if (this.possBlocks.length > 1) {
            for (let i = 0; i < this.possBlocks.length; i++) {
                const blockId = this.possBlocks[i].block._id;
                if (possBlocksById[blockId]) possBlocksById[blockId].push(this.possBlocks[i]);
                else possBlocksById[blockId] = [this.possBlocks[i]];
            }
            this.possBlocks.sort((a, b) => {
                if (a.block.timestamp !== b.block.timestamp) return a.block.timestamp - b.block.timestamp;
                else return a.block.hash < b.block.hash ? -1 : 1;
            });
        }

        for (let i = 0; i < this.possBlocks.length; i++) {
            const possBlock = this.possBlocks[i];
            logger.debug(
                `consensus.tryNextStep: possBlock[${i}] - blockId=${possBlock.block._id}, round0=${possBlock[0]?.length || 0}, round1=${possBlock[1]?.length || 0}, finalRound=${possBlock[(config.consensusRounds || 2) - 1]?.length || 0}`
            );
            //logger.cons('T'+Math.ceil(threshold)+' R0-'+possBlock[0].length+' R1-'+possBlock[1].length)
            if (
                possBlock[(config.consensusRounds || 2) - 1].length > threshold &&
                !this.finalizing &&
                possBlock.block._id === chain.getLatestBlock?.()._id + 1 &&
                possBlock[0] &&
                possBlock[0].indexOf(process.env.STEEM_ACCOUNT) !== -1
            ) {
                this.finalizing = true;

                // log which block got applied if collision exists
                if (possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1) {
                    const collisions = [];
                    for (let j = 0; j < possBlocksById[possBlock.block._id].length; j++) {
                        collisions.push([
                            possBlocksById[possBlock.block._id][j].block.witness,
                            possBlocksById[possBlock.block._id][j].block.timestamp,
                        ]);
                    }

                    logger.warn('Block collision detected at height ' + possBlock.block._id + ', the witnesses are:', collisions);

                    // In sync mode, use deterministic collision resolution
                    if (steem.isInSyncMode() && !p2p.recovering) {
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
                            else if (
                                currentBlock.timestamp === winningBlockData.timestamp &&
                                currentBlock.hash < winningBlockData.hash
                            ) {
                                winningBlock = collidingPossBlock;
                            }
                        }

                        // If this isn't the winning block, remove it and wait for the winner
                        if (possBlock.block.hash !== winningBlock.block.hash) {
                            // Remove losing blocks from consideration
                            const newPossBlocks = [];
                            for (let y = 0; y < this.possBlocks.length; y++) {
                                if (this.possBlocks[y].block.hash !== possBlock.block.hash) {
                                    newPossBlocks.push(this.possBlocks[y]);
                                }
                            }
                            this.possBlocks = newPossBlocks;
                            this.finalizing = false; // Reset and wait for winning block
                            return;
                        }
                    }

                    // In normal mode, apply the winning block as before
                    logger.info(
                        'Applying block ' +
                            possBlock.block._id +
                            '#' +
                            possBlock.block.hash.substr(0, 4) +
                            ' by ' +
                            possBlock.block.witness +
                            ' with timestamp ' +
                            possBlock.block.timestamp
                    );
                }
                chain.validateAndAddBlock(possBlock.block, false, (err: any) => {
                    if (err) {
                        logger.error(`[CONSENSUS-TRYSTEP] Error for block ${possBlock.block?._id}:`, err);
                    }
                    const newPossBlocks = [];
                    for (let y = 0; y < this.possBlocks.length; y++)
                        if (possBlock.block._id < this.possBlocks[y].block._id) newPossBlocks.push(this.possBlocks[y]);
                    this.possBlocks = newPossBlocks;
                    this.finalizing = false; // Reset finalizing status here.
                });
            } else
                for (let y = 0; y < (config.consensusRounds || 2) - 1; y++)
                    if (possBlock[y].length > threshold) this.round(y + 1, possBlock.block);
        }
    },
    round: function (round: number, block: any, cb?: (result: number) => void) {
        logger.debug(
            `consensus.round: round=${round}, block keys=[${Object.keys(block).join(',')}], block._id=${block._id}, needsFullBlock=${!!(block._id && block.witness && block.timestamp && block.hash)}`
        );

        if (block._id && block._id !== chain.getLatestBlock?.()._id + 1) {
            logger.debug(
                `consensus.round: Rejecting block - wrong _id. Expected ${chain.getLatestBlock?.()._id + 1}, got ${block._id}`
            );
            if (cb) cb(-1);
            return;
        }
        if (block.hash === chain.getLatestBlock?.().hash) {
            logger.debug(`consensus.round: Rejecting block - same hash as current head`);
            if (cb) cb(-1);
            return;
        }

        // COLLISION WINDOW - Use synchronized window only when needed (sync mode or multiple witnesses)
        const activeWitnessCount = this.activeWitnesses().length;
        const activeWitnessList = this.activeWitnesses();
        const needCollisionWindow = steem.isInSyncMode() || activeWitnessCount > 1;

        logger.debug(
            `[DEBUG-COLLISION] Block ${block._id} - activeWitnesses: ${activeWitnessCount} [${activeWitnessList.join(',')}], syncMode: ${steem.isInSyncMode()}, needCollisionWindow: ${needCollisionWindow}`
        );

        if (round === 0 && needCollisionWindow && block._id && block.witness && block.timestamp && block.hash) {
            logger.debug(
                `[COLLISION-WINDOW] Using collision window for height ${block._id} (activeWitnesses: ${activeWitnessCount}, syncMode: ${steem.isInSyncMode()})`
            );
            const blockHeight = block._id;

            // Check if we already have a timer for this height
            if (!syncCollisionTimers[blockHeight]) {
                // Use the earliest block timestamp we've seen + collision window as the deadline
                // This ensures all nodes use the same reference point once they see any block for this height
                let earliestTimestamp = block.timestamp;

                // Check if we have other pending blocks for this height to find the earliest timestamp
                if (syncPendingBlocks[blockHeight]) {
                    for (const pendingBlock of syncPendingBlocks[blockHeight]) {
                        if (pendingBlock.block.timestamp < earliestTimestamp) {
                            earliestTimestamp = pendingBlock.block.timestamp;
                        }
                    }
                }

                const windowEndTime = earliestTimestamp + SYNC_COLLISION_WINDOW_MS;
                const currentTime = Date.now();
                const timeUntilWindowEnd = Math.max(50, windowEndTime - currentTime); // Minimum 50ms

                logger.debug(
                    `[COLLISION-WINDOW] Starting synchronized collision window for height ${blockHeight}, ends in ${timeUntilWindowEnd}ms (reference: ${earliestTimestamp})`
                );
                if (!syncPendingBlocks[blockHeight]) {
                    syncPendingBlocks[blockHeight] = [];
                }

                syncCollisionTimers[blockHeight] = setTimeout(() => {
                    processSyncCollisionWindow(blockHeight);
                }, timeUntilWindowEnd);
            } else {
                // Update the collision window if this block has an earlier timestamp
                if (syncPendingBlocks[blockHeight] && syncPendingBlocks[blockHeight].length > 0) {
                    let earliestTimestamp = block.timestamp;
                    for (const pendingBlock of syncPendingBlocks[blockHeight]) {
                        if (pendingBlock.block.timestamp < earliestTimestamp) {
                            earliestTimestamp = pendingBlock.block.timestamp;
                        }
                    }

                    // If this is the new earliest block, reset the timer
                    if (block.timestamp < earliestTimestamp) {
                        clearTimeout(syncCollisionTimers[blockHeight]);
                        const windowEndTime = block.timestamp + SYNC_COLLISION_WINDOW_MS;
                        const currentTime = Date.now();
                        const timeUntilWindowEnd = Math.max(50, windowEndTime - currentTime);

                        logger.debug(
                            `[COLLISION-WINDOW] Updated collision window for height ${blockHeight} with earlier timestamp, ends in ${timeUntilWindowEnd}ms`
                        );
                        syncCollisionTimers[blockHeight] = setTimeout(() => {
                            processSyncCollisionWindow(blockHeight);
                        }, timeUntilWindowEnd);
                    }
                }
            }

            // Add this block to pending blocks for this height
            syncPendingBlocks[blockHeight].push({ block, cb });
            logger.debug(
                `[COLLISION-WINDOW] Added block from ${block.witness} to collision window for height ${blockHeight} (${syncPendingBlocks[blockHeight].length} total)`
            );
            return; // Don't process immediately
        }

        this.processBlockNormally(round, block, cb);
    },

    processBlockNormally: async function (round: number, block: any, cb?: (result: number) => void) {
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

            const possBlock: any = { block };

            for (let r = 0; r < config.consensusRounds; r++) possBlock[r] = [];
            logger.debug('New poss block ' + block._id + '/' + block.witness + '/' + block.hash.substr(0, 4));
            const isValid = await isValidNewBlock(block, true, true);
            this.validating.splice(this.validating.indexOf(possBlock.block.hash), 1);
            if (!isValid) {
                logger.error('Received invalid new block from ' + block.witness, block.hash);
                if (cb) cb(-1);
            } else {
                logger.debug('Precommitting block ' + block._id + '#' + block.hash.substr(0, 4));

                // Track witness activity when they mine a block
                if (!this.witnessLastSeen) {
                    this.witnessLastSeen = new Map<string, number>();
                }
                this.witnessLastSeen.set(block.witness, Date.now());

                this.possBlocks.push(possBlock);

                for (let i = 0; i < this.possBlocks.length; i++)
                    if (
                        block.hash === this.possBlocks[i].block.hash &&
                        this.possBlocks[i][0].indexOf(process.env.STEEM_ACCOUNT) === -1
                    ) {
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
        } else {
            for (let b = 0; b < this.possBlocks.length; b++)
                if (
                    this.possBlocks[b].block.hash === block.hash &&
                    this.possBlocks[b][round].indexOf(process.env.STEEM_ACCOUNT) === -1
                ) {
                    this.possBlocks[b][round].push(process.env.STEEM_ACCOUNT);
                    this.endRound(round, block);
                }
        }
    },
    endRound: function (round: number, block: any, _roundCallback?: Function) {
        logger.debug(`consensus.endRound: round ${round}, block ${block._id}, isActive: ${this.isActive()}`);
        if (this.isActive()) {
            let onlyBlockHash: any = { hash: block.hash };
            if (block.witness === process.env.STEEM_ACCOUNT && round === 0) onlyBlockHash = block;
            const signed = signMessage({
                t: MessageType.BLOCK_CONF_ROUND,
                d: { r: round, b: onlyBlockHash, ts: new Date().getTime() },
            });
            logger.debug(
                `consensus.endRound: Broadcasting block confirmation for block ${block._id}. Payload:`,
                JSON.stringify({ r: round, b: onlyBlockHash, ts: new Date().getTime() })
            );
            p2p.broadcast(signed);
        } else {
            logger.debug(`consensus.endRound: Not active, skipping broadcast for block ${block._id}`);
        }
        this.tryNextStep();
    },
    remoteRoundConfirm: function (message: any) {
        const block = message.d.b;
        const round = message.d.r;
        const witness = message.s.n;

        // Track witness activity for timeout detection
        if (!this.witnessLastSeen) {
            this.witnessLastSeen = new Map<string, number>();
        }
        this.witnessLastSeen.set(witness, Date.now());

        logger.debug(
            `consensus.remoteRoundConfirm: witness=${witness}, round=${round}, blockHash=${block.hash}, possBlocks.length=${this.possBlocks.length}`
        );
        for (let i = 0; i < this.possBlocks.length; i++) {
            if (block.hash === this.possBlocks[i].block.hash) {
                logger.debug(`consensus.remoteRoundConfirm: Found matching block at index ${i}`);
                if (this.possBlocks[i][round] && this.possBlocks[i][round].indexOf(witness) === -1) {
                    for (let r = round; r >= 0; r--) {
                        if (this.possBlocks[i][r].indexOf(witness) === -1) {
                            this.possBlocks[i][r].push(witness);
                            logger.debug(
                                `consensus.remoteRoundConfirm: Added witness ${witness} to round ${r}, now has ${this.possBlocks[i][r].length} confirmations`
                            );
                        }
                    }
                    logger.debug(`consensus.remoteRoundConfirm: Added witness confirmation, calling tryNextStep`);
                    this.tryNextStep();
                } else {
                    logger.debug(`consensus.remoteRoundConfirm: Witness ${witness} already confirmed for round ${round}`);
                }
                break;
            }
        }
        if (this.possBlocks.length === 0) {
            logger.debug(`consensus.remoteRoundConfirm: No possBlocks available`);
        }
    },

    handleSyncCollisionWithNetworkQuery: function (collisionHeight: number, _collisions: any[], _savedPossBlocks: any[]) {
        logger.debug(`[SYNC-COLLISION] Querying network consensus for collision at height ${collisionHeight}`);

        // Query peer head blocks to see if majority advanced
        const peersWithStatus = p2p.sockets.filter(
            ws =>
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
            logger.warn(
                `[SYNC-COLLISION] Network majority (${peersAdvanced.length}/${peersWithStatus.length}) advanced past collision. Requesting winning block.`
            );

            // Find the most common head block among advanced peers
            const headBlocks: { [key: number]: number } = {};
            peersAdvanced.forEach(ws => {
                const headBlock = ws.node_status!.head_block;
                headBlocks[headBlock] = (headBlocks[headBlock] || 0) + 1;
            });

            const winningHeight = Object.keys(headBlocks)
                .map(Number)
                .reduce((a, b) => (headBlocks[a] > headBlocks[b] ? a : b));

            // Request the winning block for collision height
            logger.warn(`[SYNC-COLLISION] Requesting block ${collisionHeight} from peer with head ${winningHeight}`);
            const championPeer = peersAdvanced.find(ws => ws.node_status!.head_block >= winningHeight);
            if (championPeer) {
                p2p.sendJSON(championPeer, { t: MessageType.QUERY_BLOCK, d: collisionHeight });
            }
        } else {
            logger.warn(
                `[SYNC-COLLISION] Network majority (${peersWithStatus.length - peersAdvanced.length}/${peersWithStatus.length}) did not advance. Proceeding with collision rejection.`
            );
            this.rejectCollisionAndWait(collisionHeight);
        }
    },

    rejectCollisionAndWait: function (collisionHeight: number) {
        logger.warn(`[SYNC-COLLISION] Rejecting all colliding blocks at height ${collisionHeight}. Chain head unchanged.`);

        // Remove all blocks at collision height from consideration
        const newPossBlocks = [];
        for (let y = 0; y < this.possBlocks.length; y++) {
            if (this.possBlocks[y].block._id !== collisionHeight) {
                newPossBlocks.push(this.possBlocks[y]);
            }
        }
        this.possBlocks = newPossBlocks;

        logger.warn(
            `[SYNC-COLLISION] Chain head remains at ${chain.getLatestBlock()._id}#${chain.getLatestBlock().hash.substr(0, 4)}. Next witness can mine cleanly.`
        );
    },
};

export default consensus;
