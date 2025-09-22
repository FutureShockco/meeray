import { WebSocketServer } from 'ws';
import logger from '../logger.js';
import { getNewKeyPair } from '../crypto.js';
import { Block } from '../block.js';
import { EnhancedWebSocket, P2PState, SteemSyncStatus } from './types.js';
import { P2P_CONFIG, P2P_RUNTIME_CONFIG } from './config.js';
import { ConnectionManager } from './connection.js';
import { PeerDiscovery } from './discovery.js';
import { MessageHandler } from './messages.js';
import { SocketManager } from './socket.js';
import { RecoveryManager } from './recovery.js';

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
const peerDiscovery = new PeerDiscovery(state, (peers, isInit) => connectionManager.connect(peers, isInit));
const recoveryManager = new RecoveryManager(state);
const messageHandler = new MessageHandler(state, peerDiscovery, recoveryManager);

SocketManager.setSockets(state.sockets);

connectionManager.setOutgoingConnectionHandler((ws: EnhancedWebSocket) => {
    messageHandler.setupMessageHandler(ws);
    errorHandler(ws);
    connectionManager.handshake(ws);
});

export const p2p = {
    get sockets() { 
        SocketManager.setSockets(state.sockets);
        return state.sockets; 
    },
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

    init(): void {
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
            recoveryManager.recover();
            setInterval(() => recoveryManager.refresh(), P2P_CONFIG.REPLAY_INTERVAL);
        }, P2P_CONFIG.REPLAY_INTERVAL);

        // Initialize discovery if enabled
        if (!P2P_RUNTIME_CONFIG.NO_DISCOVERY) {
            logger.debug('[INIT] Discovery enabled, starting discovery worker');
            setInterval(() => peerDiscovery.discoveryWorker(), P2P_CONFIG.DISCOVERY_INTERVAL);
            peerDiscovery.discoveryWorker(true);
        } else {
            logger.debug('[INIT] Discovery disabled via NO_DISCOVERY flag');
        }

        // Initialize peer list requests (primary discovery method)
        logger.debug('[INIT] Setting up peer list requests');
        setInterval(() => peerDiscovery.requestPeerLists(), P2P_CONFIG.PEER_LIST_REQUEST_INTERVAL);
        setTimeout(() => peerDiscovery.requestPeerLists(), P2P_CONFIG.PEER_LIST_INITIAL_DELAY);

        // Initialize keep-alive and cleanup
        setTimeout(() => connectionManager.keepAlive(), P2P_CONFIG.KEEP_ALIVE_INTERVAL);
        setInterval(() => SocketManager.cleanRoundConfHistory(), P2P_CONFIG.HISTORY_INTERVAL);
    },

    generateNodeId: () => generateNodeId(),
    requestPeerLists: () => peerDiscovery.requestPeerLists(),
    discoveryWorker: (isInit?: boolean) => peerDiscovery.discoveryWorker(isInit),
    keepAlive: () => connectionManager.keepAlive(),
    connect: (peers: string[], isInit?: boolean) => connectionManager.connect(peers, isInit),
    handshake: (ws: EnhancedWebSocket) => handshake(ws),
    
    messageHandler: (ws: EnhancedWebSocket) => messageHandler.setupMessageHandler(ws),

    recover: () => recoveryManager.recover(),
    refresh: (force?: boolean) => recoveryManager.refresh(force),
    addRecursive: (block: Block) => messageHandler.addRecursive(block),

    errorHandler: (ws: EnhancedWebSocket) => errorHandler(ws),
    closeConnection: (ws: EnhancedWebSocket) => connectionManager.closeConnection(ws),
    sendJSON: (ws: EnhancedWebSocket, data: any) => SocketManager.sendJSON(ws, data),
    broadcast: (data: any) => { 
        SocketManager.setSockets(state.sockets); 
        return SocketManager.broadcast(data); 
    },
    broadcastNotSent: (data: any) => { 
        SocketManager.setSockets(state.sockets); 
        return SocketManager.broadcastNotSent(data); 
    },
    broadcastBlock: (block: Block) => { 
        SocketManager.setSockets(state.sockets); 
        return SocketManager.broadcastBlock(block); 
    },
    broadcastSyncStatus: (syncStatus: SteemSyncStatus) => { 
        SocketManager.setSockets(state.sockets); 
        return SocketManager.broadcastSyncStatus(syncStatus); 
    },
    cleanRoundConfHistory: () => SocketManager.cleanRoundConfHistory()
};

// Internal functions
function generateNodeId(): void {
    state.nodeId = getNewKeyPair();
    if (state.nodeId) {
        logger.info('P2P ID: ' + state.nodeId.pub);
    }
}

function handshake(ws: EnhancedWebSocket): void {
    logger.debug('New incoming connection, setting up handshake');
    messageHandler.setupMessageHandler(ws);
    errorHandler(ws);
    connectionManager.handshake(ws);
}

function errorHandler(ws: EnhancedWebSocket): void {
    ws.on('close', () => connectionManager.closeConnection(ws));
    ws.on('error', () => connectionManager.closeConnection(ws));
}

export default p2p;
export { MessageType } from './types.js';