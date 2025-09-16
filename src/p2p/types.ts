import WebSocket from 'ws';
import { Block } from '../block.js';

// Message Types
export enum MessageType {
    QUERY_NODE_STATUS = 0,
    NODE_STATUS = 1,
    QUERY_BLOCK = 2,
    BLOCK = 3,
    NEW_BLOCK = 4,
    BLOCK_CONF_ROUND = 5,
    STEEM_SYNC_STATUS = 6,
    QUERY_PEER_LIST = 7,
    PEER_LIST = 8
}

// Interfaces
export interface NodeStatus {
    nodeId: string;
    head_block: number;
    head_block_hash: string;
    previous_block_hash: string;
    origin_block: string;
    version: string;
    sign?: string;
}

export interface SteemSyncStatus {
    nodeId: string;
    behindBlocks: number;
    steemBlock: number;
    isSyncing: boolean;
    blockId: number;
    consensusBlocks: any;
    exitTarget: number | null;
    timestamp: number;
    relayed?: boolean;
}

export interface EnhancedWebSocket extends WebSocket {
    _socket: any;
    node_status?: NodeStatus;
    steemSyncStatus?: SteemSyncStatus;
    challengeHash?: string;
    receivedChallenge?: string;
    pendingDisconnect?: NodeJS.Timeout;
    sentUs?: [string, number][];
    _peerUrl?: string;
}

export interface NodeKeyPair {
    priv: string;
    pub: string;
}

export interface P2PState {
    sockets: EnhancedWebSocket[];
    recoveringBlocks: number[];
    recoveredBlocks: Record<number, Block>;
    recovering: boolean | number;
    recoverAttempt: number;
    nodeId: NodeKeyPair | null;
    connectingPeers: Set<string>;
    lastEmergencyDiscovery: number;
    lastPeerListConnection: number;
}
