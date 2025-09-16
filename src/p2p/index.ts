import { WebSocketServer } from 'ws';
import baseX from 'base-x';
import config from '../config.js';
import logger from '../logger.js';
import { getNewKeyPair } from '../crypto.js';
import { Block } from '../block.js';
import { chain } from '../chain.js';

// Import the modular components
import { 
    EnhancedWebSocket, 
    P2PState, 
    NodeKeyPair, 
    MessageType,
    SteemSyncStatus 
} from './types.js';
import { P2P_CONFIG, P2P_RUNTIME_CONFIG } from './config.js';
import { ConnectionManager } from './connection.js';
import { PeerDiscovery } from './discovery.js';

// Import message handlers (to be created)
import { MessageHandler } from './messages.js';

const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

// State object
const state: P2PState = {
    sockets: [],
    recoveringBlocks: [],
    recoveredBlocks: {},
    recovering: false,
    recoverAttempt: 0,
    nodeId: null,
    connectingPeers: new Set<string>(),
    lastEmergencyDiscovery: 0,
    lastPeerListConnection: 0
};

// Initialize sub-modules
const connectionManager = new ConnectionManager(state);
const messageHandler = new MessageHandler(state, sendJSON);
const peerDiscovery = new PeerDiscovery(state, sendJSON, (peers, isInit) => connectionManager.connect(peers, isInit));

// Main P2P object that maintains compatibility with existing interface
export const p2p = {
    // Expose state properties for backward compatibility
    get sockets() { return state.sockets; },
    get recoveringBlocks() { return state.recoveringBlocks; },
    get recoveredBlocks() { return state.recoveredBlocks; },
    get recovering() { return state.recovering; },
    set recovering(value: boolean | number) { state.recovering = value; },
    get recoverAttempt() { return state.recoverAttempt; },
    set recoverAttempt(value: number) { state.recoverAttempt = value; },
    get nodeId() { return state.nodeId; },
    get connectingPeers() { return state.connectingPeers; },
    get lastEmergencyDiscovery() { return state.lastEmergencyDiscovery; },
    get lastPeerListConnection() { return state.lastPeerListConnection; },

    async init(): Promise<void> {
        generateNodeId();
        const server = new WebSocketServer({ 
            host: P2P_RUNTIME_CONFIG.P2P_HOST, 
            port: P2P_RUNTIME_CONFIG.P2P_PORT 
        });
        server.on('connection', (ws) => handshake(ws as EnhancedWebSocket));

        logger.info('Listening websocket p2p port on: ' + P2P_RUNTIME_CONFIG.P2P_PORT);
        logger.info('Version: ' + P2P_CONFIG.VERSION);

        // Initialize recovery and refresh
        setTimeout(() => {
            recover();
            setInterval(() => refresh(), P2P_CONFIG.REPLAY_INTERVAL);
        }, P2P_CONFIG.REPLAY_INTERVAL);

        // Initialize discovery if enabled
        if (!P2P_RUNTIME_CONFIG.NO_DISCOVERY) {
            setInterval(() => peerDiscovery.discoveryWorker(), P2P_CONFIG.DISCOVERY_INTERVAL);
            peerDiscovery.discoveryWorker(true);
        }

        // Initialize peer list requests (primary discovery method)
        setInterval(() => peerDiscovery.requestPeerLists(), P2P_CONFIG.PEER_LIST_REQUEST_INTERVAL);
        setTimeout(() => peerDiscovery.requestPeerLists(), P2P_CONFIG.PEER_LIST_INITIAL_DELAY);

        // Initialize keep-alive and cleanup
        setTimeout(() => connectionManager.keepAlive(), P2P_CONFIG.KEEP_ALIVE_INTERVAL);
        setInterval(() => cleanRoundConfHistory(), P2P_CONFIG.HISTORY_INTERVAL);
    },

    // Delegate to sub-modules
    generateNodeId: () => generateNodeId(),
    requestPeerLists: () => peerDiscovery.requestPeerLists(),
    discoveryWorker: (isInit?: boolean) => peerDiscovery.discoveryWorker(isInit),
    keepAlive: () => connectionManager.keepAlive(),
    connect: (peers: string[], isInit?: boolean) => connectionManager.connect(peers, isInit),
    handshake: (ws: EnhancedWebSocket) => handshake(ws),
    
    // Message handling - delegate to MessageHandler
    messageHandler: (ws: EnhancedWebSocket) => messageHandler.setupMessageHandler(ws),
    handleNodeStatusQuery: (ws: EnhancedWebSocket, message: any) => messageHandler.handleNodeStatusQuery(ws, message),
    handleNodeStatus: (ws: EnhancedWebSocket, message: any) => messageHandler.handleNodeStatus(ws, message),
    handleBlockQuery: (ws: EnhancedWebSocket, message: any) => messageHandler.handleBlockQuery(ws, message),
    handleBlock: (ws: EnhancedWebSocket, message: any) => messageHandler.handleBlock(ws, message),
    handleNewBlock: (ws: EnhancedWebSocket, message: any) => messageHandler.handleNewBlock(ws, message),
    handleBlockConfRound: (ws: EnhancedWebSocket, message: any) => messageHandler.handleBlockConfRound(ws, message),
    handleSteemSyncStatus: (ws: EnhancedWebSocket, message: any) => messageHandler.handleSteemSyncStatus(ws, message),
    handlePeerListQuery: (ws: EnhancedWebSocket, message: any) => peerDiscovery.handlePeerListQuery(ws, message),
    handlePeerList: (ws: EnhancedWebSocket, message: any) => peerDiscovery.handlePeerList(ws, message),

    // Core functions - these will remain in this file for now
    recover: () => recover(),
    refresh: (force?: boolean) => refresh(force),
    addRecursive: (block: Block) => messageHandler.addRecursive(block),

    // Communication functions
    errorHandler: (ws: EnhancedWebSocket) => errorHandler(ws),
    closeConnection: (ws: EnhancedWebSocket) => connectionManager.closeConnection(ws),
    sendJSON: (ws: EnhancedWebSocket, data: any) => sendJSON(ws, data),
    broadcast: (data: any) => broadcast(data),
    broadcastNotSent: (data: any) => broadcastNotSent(data),
    broadcastBlock: (block: Block) => broadcastBlock(block),
    broadcastSyncStatus: (syncStatus: SteemSyncStatus) => broadcastSyncStatus(syncStatus),
    cleanRoundConfHistory: () => cleanRoundConfHistory()
};

// Internal functions
function generateNodeId(): void {
    state.nodeId = getNewKeyPair();
    if (state.nodeId) {
        logger.info('P2P ID: ' + state.nodeId.pub);
    }
}

function handshake(ws: EnhancedWebSocket): void {
    connectionManager.handshake(ws);
    messageHandler.setupMessageHandler(ws);
    errorHandler(ws);
}

// Core P2P functions that remain here (these are complex and interconnected)
function recover(): void {
    if (!state.sockets.length) return;
    if (Object.keys(state.recoveredBlocks).length + state.recoveringBlocks.length > P2P_CONFIG.MAX_BLOCKS_BUFFER) return;

    if (!state.recovering) {
        state.recovering = chain.getLatestBlock()._id;
    }

    const currentBlock = chain.getLatestBlock()._id;
    logger.trace('Current block:', currentBlock);

    // Debug each socket's status
    state.sockets.forEach((socket, index) => {
        logger.trace(`Peer ${index}:`, {
            hasNodeStatus: !!socket.node_status,
            headBlock: socket.node_status?.head_block,
            originBlock: socket.node_status?.origin_block,
            isAhead: socket.node_status ? socket.node_status.head_block > currentBlock : false,
            originMatches: socket.node_status?.origin_block === config.originHash
        });
    });

    const peersAhead = state.sockets.filter(socket =>
        socket.node_status &&
        socket.node_status.head_block > chain.getLatestBlock()._id &&
        socket.node_status.origin_block === config.originHash
    );

    if (peersAhead.length === 0) {
        state.recovering = false;
        return;
    }

    const champion = peersAhead[Math.floor(Math.random() * peersAhead.length)];
    const nextBlock = (state.recovering as number) + 1;

    if (nextBlock <= champion.node_status!.head_block) {
        state.recovering = nextBlock;
        sendJSON(champion, { t: MessageType.QUERY_BLOCK, d: nextBlock });
        state.recoveringBlocks.push(nextBlock);

        logger.trace(`Querying block #${nextBlock} from peer (head: ${champion.node_status!.head_block})`);

        if (nextBlock % 2) {
            recover();
        }
    } 
}

function refresh(force: boolean = false): void {
    if (state.recovering && !force) return;

    for (const socket of state.sockets) {
        if (socket.node_status &&
            socket.node_status.head_block > chain.getLatestBlock()._id + 10 &&
            socket.node_status.origin_block === config.originHash) {

            logger.info(`Catching up with network, peer head block: ${socket.node_status.head_block}`);
            state.recovering = chain.getLatestBlock()._id;
            recover();
            break;
        }
    }
}

// Communication functions
function errorHandler(ws: EnhancedWebSocket): void {
    ws.on('close', () => connectionManager.closeConnection(ws));
    ws.on('error', () => connectionManager.closeConnection(ws));
}

function sendJSON(ws: EnhancedWebSocket, data: any): void {
    try {
        ws.send(JSON.stringify(data));
    } catch (error) {
        logger.warn('Failed to send P2P message:', error);
    }
}

function broadcast(data: any): void {
    state.sockets.forEach(ws => sendJSON(ws, data));
}

function broadcastNotSent(data: any): void {
    for (const socket of state.sockets) {
        if (!socket.sentUs) {
            sendJSON(socket, data);
            continue;
        }

        let shouldSend = true;
        for (const sent of socket.sentUs) {
            if (sent[0] === data.s?.s) {
                shouldSend = false;
                break;
            }
        }

        if (shouldSend) {
            sendJSON(socket, data);
        }
    }
}

function broadcastBlock(block: Block): void {
    broadcast({ t: MessageType.NEW_BLOCK, d: block });
}

function broadcastSyncStatus(syncStatus: SteemSyncStatus): void {
    broadcast({ t: MessageType.STEEM_SYNC_STATUS, d: syncStatus });
}

function cleanRoundConfHistory(): void {
    const now = Date.now();
    for (const socket of state.sockets) {
        if (!socket.sentUs) continue;
        for (let i = socket.sentUs.length - 1; i >= 0; i--) {
            if (now - socket.sentUs[i][1] > P2P_CONFIG.KEEP_HISTORY_FOR) {
                socket.sentUs.splice(i, 1);
            }
        }
    }
}

// Export both default and named for compatibility
export default p2p;
export { MessageType } from './types.js';
