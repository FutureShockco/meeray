import chain from '../chain.js';
import config from '../config.js';
import logger from '../logger.js';
import p2p from '../p2p/index.js';
import SteemApiClient from './apiClient.js';
import steemConfig from './config.js';

interface SyncStatus {
    nodeId: string;
    behindBlocks: number;
    steemBlock: number;
    isSyncing: boolean;
    blockId: number;
    consensusBlocks: any;
    exitTarget: number | null;
    timestamp: number;
}

class SyncManager {
    private isSyncing = false;
    private behindBlocks = 0;
    private syncExitTargetBlock: number | null = null;
    private postSyncLenientUntil: number | null = null;
    private lastSyncExitTime: number | null = null;
    private readySent = false;
    private networkSyncStatus = new Map<string, SyncStatus>();
    private apiClient: SteemApiClient;

    // Sync status broadcasting management
    private syncStatusBroadcastInterval: any | null = null;
    private lastBroadcastInterval: number | null = null;
    private lastBroadcastedSyncStatus: Partial<SyncStatus> = {};
    private lastForcedBroadcast = 0;
    private statusBroadcastCounter = 0;

    constructor(apiClient: SteemApiClient) {
        this.apiClient = apiClient;
    }

    enterSyncMode(): void {
        if (this.isSyncing) {
            logger.debug('Already in sync mode, ignoring enterSyncMode call');
            return;
        }

        logger.info('Entering sync mode');
        this.isSyncing = true;
        this.syncExitTargetBlock = null;
        this.readySent = false;
        this.statusBroadcastCounter = 0;

        this.startSyncStatusBroadcasting();
        this.broadcastCurrentStatus();
    }

    exitSyncMode(currentBlockId: number, currentSteemBlockNum: number): void {
        if (!this.isSyncing) {
            logger.debug('Not in sync mode, ignoring exitSyncMode call');
            return;
        }

        logger.info(`Exiting sync mode at block ${currentBlockId} (Steem block: ${currentSteemBlockNum})`);
        this.isSyncing = false;
        this.postSyncLenientUntil = currentBlockId + steemConfig.postSyncLenientBlocks;
        this.lastSyncExitTime = Date.now();

        logger.info(`Setting lenient validation until block ${this.postSyncLenientUntil}`);

        this.broadcastExitStatus(currentBlockId, currentSteemBlockNum);
        this.startSyncStatusBroadcasting();
    }

    private broadcastCurrentStatus(): void {
        if (p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
            const currentStatus: SyncStatus = {
                nodeId: p2p.nodeId?.pub || 'unknown',
                behindBlocks: this.behindBlocks,
                steemBlock: 0, // Will be set by caller
                isSyncing: true,
                blockId: chain.getLatestBlock()?._id || 0,
                consensusBlocks: {},
                exitTarget: null,
                timestamp: Date.now(),
            };
            p2p.broadcastSyncStatus(currentStatus);
        }
    }

    private broadcastExitStatus(currentBlockId: number, currentSteemBlockNum: number): void {
        if (p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
            const exitStatus: SyncStatus = {
                nodeId: p2p.nodeId?.pub || 'unknown',
                behindBlocks: this.behindBlocks,
                steemBlock: currentSteemBlockNum,
                isSyncing: false,
                blockId: currentBlockId,
                consensusBlocks: {},
                exitTarget: null,
                timestamp: Date.now(),
            };

            p2p.broadcastSyncStatus(exitStatus);
            this.statusBroadcastCounter = 0;

            const rapidBroadcastExit = () => {
                if (this.statusBroadcastCounter < steemConfig.maxRapidBroadcasts && !this.isSyncing) {
                    p2p.broadcastSyncStatus(exitStatus);
                    this.statusBroadcastCounter++;
                    setTimeout(rapidBroadcastExit, 500);
                }
            };
            setTimeout(rapidBroadcastExit, 250);
        }
    }

    private startSyncStatusBroadcasting(): void {
        this.stopSyncStatusBroadcasting();
        const jitter = Math.floor(Math.random() * 2000);
        this.syncStatusBroadcastInterval = setInterval(
            () => this.broadcastSyncStatusLoop(),
            steemConfig.defaultBroadcastInterval + jitter
        );
        this.lastBroadcastInterval = steemConfig.defaultBroadcastInterval;
        this.broadcastSyncStatusLoop();
    }

    private stopSyncStatusBroadcasting(): void {
        if (this.syncStatusBroadcastInterval) {
            clearInterval(this.syncStatusBroadcastInterval);
            this.syncStatusBroadcastInterval = null;
            this.lastBroadcastInterval = null;
        }
    }

    private broadcastSyncStatusLoop(): void {
        if (!(p2p.nodeId && p2p.sockets && p2p.sockets.length > 0)) {
            setTimeout(() => this.broadcastSyncStatusLoop(), 1000);
            return;
        }

        const statusToBroadcast: SyncStatus = {
            nodeId: p2p.nodeId?.pub || 'unknown',
            behindBlocks: this.behindBlocks,
            steemBlock: 0, // Will be set by caller
            isSyncing: this.isSyncing,
            blockId: chain.getLatestBlock()?._id || 0,
            consensusBlocks: {},
            exitTarget: this.syncExitTargetBlock,
            timestamp: Date.now(),
        };

        const targetInterval = this.isSyncing ? steemConfig.fastBroadcastInterval : steemConfig.defaultBroadcastInterval;
        const significantChange =
            statusToBroadcast.isSyncing !== this.lastBroadcastedSyncStatus.isSyncing ||
            Math.abs((statusToBroadcast.behindBlocks || 0) - (this.lastBroadcastedSyncStatus.behindBlocks || 0)) > 2 ||
            statusToBroadcast.exitTarget !== this.lastBroadcastedSyncStatus.exitTarget;

        const now = Date.now();
        if (significantChange || now - this.lastForcedBroadcast > targetInterval) {
            p2p.broadcastSyncStatus(statusToBroadcast);
            this.lastBroadcastedSyncStatus = { ...statusToBroadcast };
            this.lastForcedBroadcast = now;
        }

        if (this.syncStatusBroadcastInterval) clearTimeout(this.syncStatusBroadcastInterval);
        const checkFrequency = Math.max(1000, targetInterval / 2);
        this.syncStatusBroadcastInterval = setTimeout(() => this.broadcastSyncStatusLoop(), checkFrequency);
    }

    async shouldExitSyncMode(currentBlockId: number): Promise<boolean> {
        if (!this.isSyncing) return false;

        // CRITICAL: Always verify current Steem lag in real-time before allowing sync exit
        try {
            const currentSteemHead = await this.apiClient.getLatestBlockNumber();
            const ourLastProcessedSteemBlock = chain.getLatestBlock()?.steemBlockNum || 0;

            if (currentSteemHead && ourLastProcessedSteemBlock) {
                const realTimeBehindBlocks = Math.max(0, currentSteemHead - ourLastProcessedSteemBlock);

                // Update our cached value if it's significantly different
                if (Math.abs(realTimeBehindBlocks - this.behindBlocks) > 10) {
                    this.behindBlocks = realTimeBehindBlocks;
                }

                // Use the real-time value for the exit decision
                const localCaughtUp = realTimeBehindBlocks <= steemConfig.syncExitThreshold;

                // NEW: Exit sync mode immediately if Steem blocks behind is lower than config.steemBlockDelay
                if (realTimeBehindBlocks < config.steemBlockDelay) {
                    logger.info(
                        `Exiting sync mode immediately: Steem blocks behind (${realTimeBehindBlocks}) is lower than steemBlockDelay (${config.steemBlockDelay}) at block ${currentBlockId}`
                    );
                    return true;
                }

                if (!localCaughtUp) {
                    return false;
                }
            } else {
                logger.warn('DEBUG: Could not get real-time Steem lag for sync exit decision, using cached value');
            }
        } catch (error) {
            logger.warn('DEBUG: Error checking real-time Steem lag for sync exit decision:', error);
        }

        // Fallback to cached value if real-time check failed
        const localCaughtUp = this.behindBlocks <= steemConfig.syncExitThreshold;

        // NEW: Also check cached value against steemBlockDelay
        if (this.behindBlocks < config.steemBlockDelay) {
            logger.info(
                `Exiting sync mode immediately (cached): Steem blocks behind (${this.behindBlocks}) is lower than steemBlockDelay (${config.steemBlockDelay}) at block ${currentBlockId}`
            );
            return true;
        }

        if (!localCaughtUp) {
            return false;
        }

        // Only check network consensus if we're actually caught up with Steem
        if (this.isNetworkReadyToExitSyncMode()) {
            logger.info(
                `Local node caught up with Steem (${this.behindBlocks} blocks behind) and network is ready to exit sync mode at block ${currentBlockId}.`
            );
            return true;
        }

        logger.info(`Local node caught up with Steem but network consensus not reached for sync mode exit`);
        return false;
    }

    private isNetworkReadyToExitSyncMode(): boolean {
        const now = Date.now();
        let nodesReadyToExit = 0;
        let consideredNodes = 0;
        const witnessAccounts = new Set(chain.schedule.active_witnesses || []);
        const activePeerNodeIds = new Set(
            p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId)
        );

        this.networkSyncStatus.forEach((status, nodeId) => {
            if (activePeerNodeIds.has(nodeId) && now - status.timestamp < steemConfig.steemHeightExpiry) {
                const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
                const isRelevantPeer = witnessAccounts.size === 0 || (peerAccount && witnessAccounts.has(peerAccount));

                if (isRelevantPeer) {
                    consideredNodes++;
                    if (
                        (!status.isSyncing && status.behindBlocks <= steemConfig.syncExitThreshold) ||
                        (status.isSyncing && status.behindBlocks <= steemConfig.syncExitThreshold) ||
                        (status.exitTarget !== null &&
                            status.exitTarget <= (chain.getLatestBlock()?._id || 0) + steemConfig.syncExitThreshold)
                    ) {
                        nodesReadyToExit++;
                    }
                }
            }
        });

        if (consideredNodes === 0) {
            return this.behindBlocks <= steemConfig.syncExitThreshold;
        }

        const percentageReady = (nodesReadyToExit / consideredNodes) * 100;
        return percentageReady >= steemConfig.syncExitQuorumPercent;
    }

    receivePeerSyncStatus(nodeId: string, status: SyncStatus): void {
        if (
            !status ||
            typeof status.behindBlocks !== 'number' ||
            typeof status.isSyncing !== 'boolean' ||
            typeof status.steemBlock !== 'number'
        ) {
            logger.warn(`Received malformed sync status from ${nodeId}:`, status);
            return;
        }

        this.networkSyncStatus.set(nodeId, { ...status, nodeId, timestamp: Date.now() });

        // Handle exit target coordination
        if (this.isSyncing && status.exitTarget !== null) {
            const currentChainBlockId = chain?.getLatestBlock()?._id || 0;
            if (status.exitTarget > currentChainBlockId && status.behindBlocks <= steemConfig.syncExitThreshold + 3) {
                if (this.syncExitTargetBlock === null || status.exitTarget < this.syncExitTargetBlock) {
                    logger.info(`Adopting syncExitTargetBlock ${status.exitTarget} from peer ${nodeId}`);
                    this.syncExitTargetBlock = status.exitTarget;
                }
            }
        }

        // Prune old statuses
        const now = Date.now();
        this.networkSyncStatus.forEach((s, id) => {
            if (now - s.timestamp > steemConfig.steemHeightExpiry * 4) {
                this.networkSyncStatus.delete(id);
            }
        });
    }

    // Getters and utility methods
    isInSyncMode(): boolean {
        return this.isSyncing;
    }
    getBehindBlocks(): number {
        return this.behindBlocks;
    }
    getSyncExitTarget(): number | null {
        return this.syncExitTargetBlock;
    }
    getLastSyncExitTime(): number | null {
        return this.lastSyncExitTime;
    }
    shouldBeLenient(blockId: number): boolean {
        return !!this.postSyncLenientUntil && blockId <= this.postSyncLenientUntil;
    }

    updateBehindBlocks(count: number): void {
        const oldValue = this.behindBlocks;
        this.behindBlocks = count;
        if (oldValue !== count) {
            logger.trace(`updateBehindBlocks: ${oldValue} -> ${count} (change: ${count - oldValue})`);
        }
    }
    setSyncExitTarget(target: number | null): void {
        this.syncExitTargetBlock = target;
    }

    handlePostSyncReady(blockId: number): void {
        if (!this.readySent && !this.isSyncing && this.postSyncLenientUntil && blockId <= this.postSyncLenientUntil) {
            if (p2p && p2p.sockets && p2p.sockets.length > 0) {
                logger.info(`Sent READY handshake to peers at block ${blockId}`);
            }
            this.readySent = true;
        }
    }

    cleanup(): void {
        this.stopSyncStatusBroadcasting();
    }
}

export default SyncManager;
