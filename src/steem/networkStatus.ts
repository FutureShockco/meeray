import { chain } from '../chain.js';
import config from '../config.js';
import logger from '../logger.js';
import p2p from '../p2p/index.js';
import steemConfig from './config.js';

interface NetworkSyncStatus {
    highestBlock: number;
    referenceExists: boolean;
    referenceNodeId: string;
    medianBlock?: number;
    nodesInSync?: number;
    totalNodes?: number;
}

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

class NetworkStatusManager {
    private networkSteemHeights = new Map<
        string,
        {
            steemBlock: number;
            behindBlocks: number;
            timestamp: number;
            blockId?: number;
            consensusBlocks?: number;
            isInWarmup?: boolean;
            exitTarget?: number | null;
        }
    >();

    private networkSyncStatus = new Map<string, SyncStatus>();

    constructor() {}

    getNetworkSyncStatus(): NetworkSyncStatus {
        const now = Date.now();
        let highestKnownBlock = chain.getLatestBlock()?._id || 0;
        let refNodeId = 'self';
        let hasReference = false;
        const activePeerBlocks: number[] = [];
        let nodesInSyncCount = 0;
        let totalConsideredNodes = 0;

        const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

        this.networkSyncStatus.forEach((status, nodeId) => {
            if (activePeerNodeIds.has(nodeId) && now - status.timestamp < steemConfig.steemHeightExpiry * 2) {
                totalConsideredNodes++;

                if (status.blockId > highestKnownBlock) {
                    highestKnownBlock = status.blockId;
                    refNodeId = nodeId;
                    hasReference = true;
                }

                activePeerBlocks.push(status.blockId);

                if (!status.isSyncing || (status.isSyncing && status.behindBlocks <= steemConfig.syncExitThreshold)) {
                    nodesInSyncCount++;
                }
            }
        });

        if (totalConsideredNodes === 0 && !p2p.recovering) {
            hasReference = false;
        }

        const median = activePeerBlocks.length > 0 ? this.getMedian(activePeerBlocks) : highestKnownBlock;

        return {
            highestBlock: highestKnownBlock,
            referenceExists: hasReference,
            referenceNodeId: refNodeId,
            medianBlock: median,
            nodesInSync: nodesInSyncCount,
            totalNodes: totalConsideredNodes > 0 ? totalConsideredNodes : 1,
        };
    }

    private getMedian(numbers: number[]): number {
        if (numbers.length === 0) return 0;
        const sorted = [...numbers].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[middle - 1] + sorted[middle]) / 2;
        }
        return sorted[middle];
    }

    getNetworkOverallBehindBlocks(): {
        maxBehind: number;
        medianBehind: number;
        numReporting: number;
        numWitnessesReporting: number;
        witnessesBehindThreshold: number;
    } {
        const now = Date.now();
        const relevantBehindValues: number[] = [];
        const witnessSteemAccounts = new Set(chain.schedule.active_witnesses || []);
        let witnessesReportingCount = 0;
        let witnessesConsideredBehindCount = 0;
        const behindThresholdForWitness = config.steemBlockDelay || 10;

        const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

        this.networkSyncStatus.forEach((status, nodeId) => {
            if (activePeerNodeIds.has(nodeId) && now - status.timestamp < steemConfig.steemHeightExpiry * 2) {
                relevantBehindValues.push(status.behindBlocks);

                const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
                if (peerAccount && witnessSteemAccounts.has(peerAccount)) {
                    witnessesReportingCount++;
                    if (status.behindBlocks > behindThresholdForWitness) {
                        witnessesConsideredBehindCount++;
                    }
                }
            }
        });

        if (relevantBehindValues.length === 0) {
            return {
                maxBehind: 0,
                medianBehind: 0,
                numReporting: 0,
                numWitnessesReporting: 0,
                witnessesBehindThreshold: 0,
            };
        }

        relevantBehindValues.sort((a, b) => a - b);
        const maxBehind = relevantBehindValues[relevantBehindValues.length - 1];
        const mid = Math.floor(relevantBehindValues.length / 2);
        const medianBehind =
            relevantBehindValues.length % 2 !== 0 ? relevantBehindValues[mid] : (relevantBehindValues[mid - 1] + relevantBehindValues[mid]) / 2;

        return {
            maxBehind,
            medianBehind,
            numReporting: relevantBehindValues.length,
            numWitnessesReporting: witnessesReportingCount,
            witnessesBehindThreshold: witnessesConsideredBehindCount,
        };
    }

    isNetworkReadyToEnterSyncMode(localNodeBehindBlocks: number, isSyncing: boolean): boolean {
        const now = Date.now();
        let nodesIndicatingSyncNeeded = 0;
        let consideredPeersForEntry = 0;
        const witnessAccounts = new Set(chain.schedule.active_witnesses || []);
        let witnessPeersIndicatingSync = 0;
        let consideredWitnessPeersForEntry = 0;
        const delayThreshold = config.steemBlockDelay || 10;

        const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

        this.networkSyncStatus.forEach((status, nodeId) => {
            if (activePeerNodeIds.has(nodeId) && now - status.timestamp < steemConfig.steemHeightExpiry * 2) {
                consideredPeersForEntry++;
                const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
                const isWitnessPeer = peerAccount && witnessAccounts.has(peerAccount);

                if (isWitnessPeer) {
                    consideredWitnessPeersForEntry++;
                } else if (witnessAccounts.size === 0) {
                    consideredWitnessPeersForEntry++;
                }

                if (status.isSyncing || status.behindBlocks > delayThreshold) {
                    nodesIndicatingSyncNeeded++;
                    if (isWitnessPeer) {
                        witnessPeersIndicatingSync++;
                    } else if (witnessAccounts.size === 0) {
                        witnessPeersIndicatingSync++;
                    }
                }
            }
        });

        // Add self to consideration if not already counted
        const selfAccount = process.env.STEEM_ACCOUNT || '';
        const selfIsWitness = witnessAccounts.has(selfAccount);
        const localNodeIndicatesSync = localNodeBehindBlocks > delayThreshold || isSyncing;

        let selfAlreadyCounted = false;
        if (
            p2p.nodeId?.pub &&
            this.networkSyncStatus.has(p2p.nodeId.pub) &&
            now - (this.networkSyncStatus.get(p2p.nodeId.pub)?.timestamp || 0) < steemConfig.steemHeightExpiry * 2
        ) {
            selfAlreadyCounted = true;
        }

        if (!selfAlreadyCounted) {
            consideredPeersForEntry++;
            if (localNodeIndicatesSync) {
                nodesIndicatingSyncNeeded++;
            }
            if (selfIsWitness || witnessAccounts.size === 0) {
                consideredWitnessPeersForEntry++;
                if (localNodeIndicatesSync) {
                    witnessPeersIndicatingSync++;
                }
            }
        }

        if (consideredPeersForEntry === 0) {
            if (localNodeBehindBlocks >= (config.steemBlockDelay * 5 || delayThreshold * 2)) {
                logger.warn(`No recent peer sync status, but local node is critically behind (${localNodeBehindBlocks} blocks). Allowing sync mode entry.`);
                return true;
            }
            return false;
        }

        let percentageIndicatingSync: number;
        let relevantConsideredNodesForEntry: number;

        const minActiveWitnessesForPriority = Math.max(steemConfig.minWitnessesForQuorumConsideration, Math.floor(witnessAccounts.size * 0.1));

        if (witnessAccounts.size > 0 && consideredWitnessPeersForEntry >= minActiveWitnessesForPriority) {
            percentageIndicatingSync = consideredWitnessPeersForEntry > 0 ? (witnessPeersIndicatingSync / consideredWitnessPeersForEntry) * 100 : 0;
            relevantConsideredNodesForEntry = consideredWitnessPeersForEntry;
            logger.warn(
                `Sync Entry Decision (Witness Priority): ${witnessPeersIndicatingSync}/${consideredWitnessPeersForEntry} relevant witnesses indicate sync needed. Quorum: ${steemConfig.syncEntryQuorumPercent}%`
            );
        } else {
            percentageIndicatingSync = consideredPeersForEntry > 0 ? (nodesIndicatingSyncNeeded / consideredPeersForEntry) * 100 : 0;
            relevantConsideredNodesForEntry = consideredPeersForEntry;
            logger.warn(
                `Sync Entry Decision (General Peers): ${nodesIndicatingSyncNeeded}/${consideredPeersForEntry} relevant peers indicate sync needed. Quorum: ${steemConfig.syncEntryQuorumPercent}%`
            );
        }

        if (percentageIndicatingSync >= steemConfig.syncEntryQuorumPercent) {
            logger.warn(
                `Network ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`
            );
            return true;
        }

        logger.warn(
            `Network NOT ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`
        );
        return false;
    }

    receivePeerSyncStatus(nodeId: string, status: SyncStatus): void {
        if (!status || typeof status.behindBlocks !== 'number' || typeof status.isSyncing !== 'boolean' || typeof status.steemBlock !== 'number') {
            logger.warn(`Received malformed sync status from ${nodeId}:`, status);
            return;
        }

        this.networkSyncStatus.set(nodeId, { ...status, nodeId, timestamp: Date.now() });

        // Prune old statuses
        const now = Date.now();
        this.networkSyncStatus.forEach((s, id) => {
            if (now - s.timestamp > steemConfig.steemHeightExpiry * 4) {
                this.networkSyncStatus.delete(id);
            }
        });

        // Also prune old Steem height data
        this.networkSteemHeights.forEach((data, id) => {
            if (now - data.timestamp > 120000) {
                // 2 minutes expiry
                this.networkSteemHeights.delete(id);
            }
        });
    }

    updateLocalSteemState(localDelay: number, headSteemBlock: number): void {
        // Broadcast the updated local status
        if (p2p.nodeId && p2p.sockets && p2p.sockets.length > 0) {
            const currentStatus: SyncStatus = {
                nodeId: p2p.nodeId?.pub || 'unknown',
                behindBlocks: localDelay,
                steemBlock: headSteemBlock,
                isSyncing: false, // Will be set by caller
                blockId: chain.getLatestBlock()?._id || 0,
                consensusBlocks: {},
                exitTarget: null, // Will be set by caller
                timestamp: Date.now(),
            };
            p2p.broadcastSyncStatus(currentStatus);
        }
    }

    cleanup(): void {
        this.networkSyncStatus.clear();
        this.networkSteemHeights.clear();
    }
}

export default NetworkStatusManager;
