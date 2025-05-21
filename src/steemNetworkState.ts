import p2p from './p2p.js';
import { chain } from './chain.js';
import config from './config.js';
import logger from './logger.js';
// import steem from './steem.js'; // Removed to prevent circular dependencies

// Interfaces (assuming SyncStatus might be imported or defined if complex)
// For now, let's define a local version or expect it to be passed.
// If SyncStatus is simple enough and only used here and in steem.ts, it could be duplicated
// or defined in a shared types file.
export interface SyncStatus {
    nodeId: string;
    behindBlocks: number;
    steemBlock: number;
    isSyncing: boolean;
    blockId: number;
    consensusBlocks: any; // TODO: Clarify this type
    exitTarget: number | null;
    timestamp: number;
}

export interface NetworkSyncStatus {
    highestBlock: number;
    referenceExists: boolean;
    referenceNodeId: string;
    medianBlock?: number;
    nodesInSync?: number;
    totalNodes?: number;
}

// State Variables
const networkSyncStatusMap = new Map<string, SyncStatus>(); // Renamed to avoid conflict if imported
// const networkSteemHeights = new Map<string, { steemBlock: number; behindBlocks: number; timestamp: number; blockId?: number; consensusBlocks?: any; isInWarmup?: boolean; exitTarget?: number | null; }>();

// Constants
export const STEEM_HEIGHT_EXPIRY = 30000; // Expire Steem heights older than 30 seconds
export const SYNC_ENTRY_QUORUM_PERCENT = (config as any).syncEntryQuorumPercent || 50;
export const SYNC_EXIT_QUORUM_PERCENT = (config as any).syncExitQuorumPercent || 60;
export const MIN_WITNESSES_FOR_QUORUM_CONSIDERATION = (config as any).minWitnessesForQuorumConsideration || 3;
// SYNC_EXIT_THRESHOLD is closely tied to local decisions in steem.ts as well.
// It will be passed as an argument to isNetworkReadyToExitSyncMode.

export function receivePeerSyncStatus(nodeId: string, status: SyncStatus): void {
    if (!status || typeof status.behindBlocks !== 'number' || typeof status.isSyncing !== 'boolean' || typeof status.steemBlock !== 'number') {
        logger.warn(`[SteemNetworkState] Received malformed sync status from ${nodeId}:`, status);
        return;
    }
    networkSyncStatusMap.set(nodeId, { ...status, nodeId, timestamp: Date.now() });
    // Prune old statuses
    const now = Date.now();
    networkSyncStatusMap.forEach((s, id) => {
        if (now - s.timestamp > STEEM_HEIGHT_EXPIRY * 4) { // Increased expiry for pruning, e.g., 2 mins
            networkSyncStatusMap.delete(id);
        }
    });
}

export function getNetworkOverallBehindBlocks(localNodeBehindBlocks: number, localNodeIsSyncing: boolean): { maxBehind: number; medianBehind: number; numReporting: number; numWitnessesReporting: number; witnessesBehindThreshold: number } {
    const now = Date.now();
    const relevantBehindValues: number[] = [];
    const witnessSteemAccounts = new Set(chain.schedule.active_witnesses || []);
    let witnessesReportingCount = 0;
    let witnessesConsideredBehindCount = 0;
    const behindThresholdForWitness = (config as any).steemBlockDelay || 10; // This could also be a passed param
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatusMap.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY * 2) { // Consider statuses up to 60s old
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

    const selfAccount = process.env.STEEM_ACCOUNT;
    let selfIsReportingWitness = false;
    if (selfAccount && witnessSteemAccounts.has(selfAccount)) {
        selfIsReportingWitness = true;
        let selfInNetworkMapAsWitness = false;
        if (p2p.nodeId?.pub && networkSyncStatusMap.has(p2p.nodeId.pub)) {
            const selfStatus = networkSyncStatusMap.get(p2p.nodeId.pub)!;
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(p2p.nodeId.pub) : null;
            if (peerAccount && witnessSteemAccounts.has(peerAccount) && (now - selfStatus.timestamp < STEEM_HEIGHT_EXPIRY * 2)) {
                selfInNetworkMapAsWitness = true;
            }
        }
        if (!selfInNetworkMapAsWitness) {
            relevantBehindValues.push(localNodeBehindBlocks); // Add local behindBlocks
            witnessesReportingCount++;
            if (localNodeBehindBlocks > behindThresholdForWitness) {
                witnessesConsideredBehindCount++;
            }
        }
    }

    if (relevantBehindValues.length === 0) {
        if (selfIsReportingWitness) {
            return { maxBehind: localNodeBehindBlocks, medianBehind: localNodeBehindBlocks, numReporting: 1, numWitnessesReporting: 1, witnessesBehindThreshold: localNodeBehindBlocks > behindThresholdForWitness ? 1 : 0 };
        }
        return { maxBehind: 0, medianBehind: 0, numReporting: 0, numWitnessesReporting: 0, witnessesBehindThreshold: 0 };
    }

    relevantBehindValues.sort((a, b) => a - b);
    const maxBehind = relevantBehindValues[relevantBehindValues.length - 1];
    const mid = Math.floor(relevantBehindValues.length / 2);
    const medianBehind = relevantBehindValues.length % 2 !== 0 ? relevantBehindValues[mid] : (relevantBehindValues[mid - 1] + relevantBehindValues[mid]) / 2;

    return {
        maxBehind,
        medianBehind,
        numReporting: relevantBehindValues.length,
        numWitnessesReporting: witnessesReportingCount,
        witnessesBehindThreshold: witnessesConsideredBehindCount
    };
}

export function isNetworkReadyToEnterSyncMode(localNodeBehindBlocks: number, localNodeIsSyncing: boolean, steemBlockDelayConfig: number ): boolean {
    const now = Date.now();
    let nodesIndicatingSyncNeeded = 0;
    let consideredPeersForEntry = 0;
    const witnessAccounts = new Set(chain.schedule.active_witnesses || []);
    let witnessPeersIndicatingSync = 0;
    let consideredWitnessPeersForEntry = 0;
    // const delayThreshold = (config as any).steemBlockDelay || 10; // Use passed steemBlockDelayConfig
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatusMap.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY * 2) {
            consideredPeersForEntry++;
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
            const isWitnessPeer = peerAccount && witnessAccounts.has(peerAccount);

            if (isWitnessPeer) {
                consideredWitnessPeersForEntry++;
            } else if (witnessAccounts.size === 0) {
                consideredWitnessPeersForEntry++;
            }

            if (status.isSyncing || status.behindBlocks > steemBlockDelayConfig) {
                nodesIndicatingSyncNeeded++;
                if (isWitnessPeer) {
                    witnessPeersIndicatingSync++;
                } else if (witnessAccounts.size === 0) {
                    witnessPeersIndicatingSync++;
                }
            }
        }
    });

    const selfAccount = process.env.STEEM_ACCOUNT || "";
    const selfIsWitness = witnessAccounts.has(selfAccount);
    const localNodeIndicatesSync = localNodeBehindBlocks > steemBlockDelayConfig || localNodeIsSyncing;

    let selfAlreadyCounted = false;
    if (p2p.nodeId?.pub && networkSyncStatusMap.has(p2p.nodeId.pub) && (now - (networkSyncStatusMap.get(p2p.nodeId.pub)?.timestamp || 0) < STEEM_HEIGHT_EXPIRY * 2)) {
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
        if (localNodeBehindBlocks >= (steemBlockDelayConfig * 5)) { // Critically behind
            logger.warn(`[SteemNetworkState] No recent peer sync status, but local node is critically behind (${localNodeBehindBlocks} blocks). Allowing sync mode entry.`);
            return true;
        }
        return false;
    }

    let percentageIndicatingSync: number;
    let relevantConsideredNodesForEntry: number;

    const minActiveWitnessesForPriority = Math.max(MIN_WITNESSES_FOR_QUORUM_CONSIDERATION, Math.floor(witnessAccounts.size * 0.1));

    if (witnessAccounts.size > 0 && consideredWitnessPeersForEntry >= minActiveWitnessesForPriority) {
        percentageIndicatingSync = consideredWitnessPeersForEntry > 0 ? (witnessPeersIndicatingSync / consideredWitnessPeersForEntry) * 100 : 0;
        relevantConsideredNodesForEntry = consideredWitnessPeersForEntry;
        logger.warn(`[SteemNetworkState] Sync Entry Decision (Witness Priority): ${witnessPeersIndicatingSync}/${consideredWitnessPeersForEntry} relevant witnesses indicate sync needed. Quorum: ${SYNC_ENTRY_QUORUM_PERCENT}%`);
    } else {
        percentageIndicatingSync = consideredPeersForEntry > 0 ? (nodesIndicatingSyncNeeded / consideredPeersForEntry) * 100 : 0;
        relevantConsideredNodesForEntry = consideredPeersForEntry;
        logger.warn(`[SteemNetworkState] Sync Entry Decision (General Peers): ${nodesIndicatingSyncNeeded}/${consideredPeersForEntry} relevant peers indicate sync needed. Quorum: ${SYNC_ENTRY_QUORUM_PERCENT}%`);
    }

    if (percentageIndicatingSync >= SYNC_ENTRY_QUORUM_PERCENT) {
        logger.warn(`[SteemNetworkState] Network ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`);
        return true;
    }
    logger.warn(`[SteemNetworkState] Network NOT ready to enter sync: ${percentageIndicatingSync.toFixed(1)}% of ${relevantConsideredNodesForEntry} relevant nodes indicate need. (Local behind: ${localNodeBehindBlocks})`);
    return false;
}

export function isNetworkReadyToExitSyncMode(localNodeBehindBlocks: number, localNodeIsSyncing: boolean, syncExitThreshold: number): boolean {
    const now = Date.now();
    let nodesReadyToExit = 0;
    let consideredNodes = 0;
    const witnessAccounts = new Set(chain.schedule.active_witnesses || []);
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));

    networkSyncStatusMap.forEach((status, nodeId) => {
        if (activePeerNodeIds.has(nodeId) && now - status.timestamp < STEEM_HEIGHT_EXPIRY) { // Use the specific STEEM_HEIGHT_EXPIRY for this check
            const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(nodeId) : null;
            let isRelevantPeer = (witnessAccounts.size === 0) || (peerAccount && witnessAccounts.has(peerAccount));

            if (isRelevantPeer) {
                consideredNodes++;
                if ((!status.isSyncing && status.behindBlocks <= syncExitThreshold) ||
                    (status.isSyncing && status.behindBlocks <= syncExitThreshold) || // Node is syncing but caught up
                    (status.exitTarget !== null && status.exitTarget <= (chain.getLatestBlock()?._id || 0) + syncExitThreshold)) { // Node has an exit target and is near/past it
                    nodesReadyToExit++;
                }
            }
        }
    });

    const selfAccount = process.env.STEEM_ACCOUNT || "";
    const selfIsWitnessOrNoWitnessList = witnessAccounts.size === 0 || witnessAccounts.has(selfAccount);

    if (localNodeIsSyncing && selfIsWitnessOrNoWitnessList) { // Only consider self if it's syncing and relevant
        let selfAlreadyCountedAsPeer = false;
        if (p2p.nodeId?.pub && networkSyncStatusMap.has(p2p.nodeId.pub)) {
            const selfStatusInMap = networkSyncStatusMap.get(p2p.nodeId.pub)!; // Should exist if nodeId is in map
             if (now - selfStatusInMap.timestamp < STEEM_HEIGHT_EXPIRY) { // Check if self's status in map is recent
                const peerAccount = (p2p as any).getPeerAccount ? (p2p as any).getPeerAccount(p2p.nodeId.pub) : null;
                let isRelevantPeer = (witnessAccounts.size === 0) || (peerAccount && witnessAccounts.has(peerAccount));
                if (isRelevantPeer) selfAlreadyCountedAsPeer = true;
            }
        }

        if (!selfAlreadyCountedAsPeer) {
            consideredNodes++;
            if (localNodeBehindBlocks <= syncExitThreshold) {
                nodesReadyToExit++;
            }
        }
    }
    
    if (consideredNodes === 0) { // If no relevant peers (and self isn't considered or isn't syncing), decision is local
        return localNodeBehindBlocks <= syncExitThreshold;
    }

    const percentageReady = (nodesReadyToExit / consideredNodes) * 100;
    return percentageReady >= SYNC_EXIT_QUORUM_PERCENT;
}

// getNetworkSyncStatus (regarding sidechain block height, not Steem lag)
// This function might be kept in steem.ts if it's used for general p2p recovery,
// or moved here if its primary use is to feed into Steem-related consensus.
// For now, let's assume it can be moved if its context fits better here.

export function getSidechainNetworkSyncStatus(): NetworkSyncStatus {
    const now = Date.now();
    let highestKnownBlock = chain.getLatestBlock()?._id || 0;
    let refNodeId = 'self';
    let hasReference = false;
    const activePeerBlocks: number[] = [];
    let nodesInSyncCount = 0; // Nodes considered "in sync" with the sidechain's head
    let totalConsideredNodes = 0;
    const activePeerNodeIds = new Set(p2p.sockets.filter(s => s.node_status && s.node_status.nodeId).map(s => s.node_status!.nodeId));
    const localSyncExitThreshold = (config as any).syncExitThreshold || 3; // Using a general threshold

    networkSyncStatusMap.forEach((status, nodeId) => {
        // Use a longer expiry for general network status vs Steem-specific height expiry
        if (activePeerNodeIds.has(nodeId) && (now - status.timestamp < STEEM_HEIGHT_EXPIRY * 4)) { 
            totalConsideredNodes++;
            if (status.blockId > highestKnownBlock) {
                highestKnownBlock = status.blockId;
                refNodeId = nodeId;
                hasReference = true;
            }
            activePeerBlocks.push(status.blockId);
            // A node is "in sync" with sidechain if not explicitly Steem-syncing OR 
            // if it is Steem-syncing but very close (in terms of Steem blocks, which is an approximation for sidechain readiness)
            if (!status.isSyncing || (status.isSyncing && status.behindBlocks <= localSyncExitThreshold)) {
                nodesInSyncCount++;
            }
        }
    });
    
    // This part needs careful thought: how does local 'isSyncing' (Steem sync) relate to general sidechain sync?
    // For now, let's assume if the local node is not Steem-syncing or is close, it counts towards general sync.
    // const localSteemIsSyncing = steem.isInSyncMode(); // This was causing circular dependency
    // const localSteemBehindBlocks = steem.getBehindBlocks(); // This was causing circular dependency
    // These values need to be passed in if getSidechainNetworkSyncStatus needs them.
    // For now, let's simplify getSidechainNetworkSyncStatus to not directly depend on local steem.ts state.
    // It will primarily reflect peer sidechain block heights.
    // The calling function (e.g. in steem.ts or chain.ts) can combine this with local state if needed.

    // To count self accurately without direct steem.ts import:
    // We can assume if the node is operational and not in p2p.recovering, it's part of the network.
    // Its own steem-sync status doesn't directly define its participation in sidechain block propagation for this function.
    if (!p2p.recovering) { // If local node is operational
        let selfInMapAndRecent = false;
        if (p2p.nodeId?.pub && networkSyncStatusMap.has(p2p.nodeId.pub)) {
            const selfStatus = networkSyncStatusMap.get(p2p.nodeId.pub)!;
            if (now - selfStatus.timestamp < STEEM_HEIGHT_EXPIRY * 4) {
                selfInMapAndRecent = true;
            }
        }
        if (!selfInMapAndRecent) {
             if(totalConsideredNodes === 0) totalConsideredNodes++; // Count self if no other nodes yet
            nodesInSyncCount++; // Assume self is in sync with its own chain head for this general status
        }
    }

    if (totalConsideredNodes === 0 && !p2p.recovering) {
        hasReference = false; 
    }

    const median = activePeerBlocks.length > 0 ? getMedian(activePeerBlocks) : highestKnownBlock;
    return {
        highestBlock: highestKnownBlock,
        referenceExists: hasReference,
        referenceNodeId: refNodeId,
        medianBlock: median,
        nodesInSync: nodesInSyncCount,
        totalNodes: totalConsideredNodes > 0 ? totalConsideredNodes : 1 
    };
}

export function getMedian(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}


const steemNetworkStateModule = {
    receivePeerSyncStatus,
    getNetworkOverallBehindBlocks,
    isNetworkReadyToEnterSyncMode,
    isNetworkReadyToExitSyncMode,
    getSidechainNetworkSyncStatus, // Renamed from getNetworkSyncStatus
    getMedian,
    // Expose constants if needed by other modules directly
    STEEM_HEIGHT_EXPIRY,
    SYNC_ENTRY_QUORUM_PERCENT,
    SYNC_EXIT_QUORUM_PERCENT,
    MIN_WITNESSES_FOR_QUORUM_CONSIDERATION,
    // networkSyncStatusMap // Typically not exposed directly, use functions
};

export default steemNetworkStateModule; 