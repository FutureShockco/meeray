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
import { MessageHandler } from './messages.js';
import { SocketManager } from './socket.js';
import { RecoveryManager } from './recovery.js';

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
const peerDiscovery = new PeerDiscovery(state, (peers, isInit) => connectionManager.connect(peers, isInit));
const messageHandler = new MessageHandler(state, peerDiscovery);
const recoveryManager = new RecoveryManager(state);

// Main P2P object that maintains compatibility with existing interface
export const p2p = {
    // Expose state properties for backward compatibility
    get sockets() { 
        SocketManager.setSockets(state.sockets); // Keep SocketManager in sync
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
            recoveryManager.recover();
            setInterval(() => recoveryManager.refresh(), P2P_CONFIG.REPLAY_INTERVAL);
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
        setInterval(() => SocketManager.cleanRoundConfHistory(), P2P_CONFIG.HISTORY_INTERVAL);
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

    // Core functions - delegate to specialized managers
    recover: () => recoveryManager.recover(),
    refresh: (force?: boolean) => recoveryManager.refresh(force),
    addRecursive: (block: Block) => messageHandler.addRecursive(block),

    // Communication functions - delegate to SocketManager
    errorHandler: (ws: EnhancedWebSocket) => errorHandler(ws),
    closeConnection: (ws: EnhancedWebSocket) => connectionManager.closeConnection(ws),
    sendJSON: (ws: EnhancedWebSocket, data: any) => SocketManager.sendJSON(ws, data),
    broadcast: (data: any) => SocketManager.broadcast(data),
    broadcastNotSent: (data: any) => SocketManager.broadcastNotSent(data),
    broadcastBlock: (block: Block) => SocketManager.broadcastBlock(block),
    broadcastSyncStatus: (syncStatus: SteemSyncStatus) => SocketManager.broadcastSyncStatus(syncStatus),
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
    connectionManager.handshake(ws);
    messageHandler.setupMessageHandler(ws);
    errorHandler(ws);
}

// Communication functions
function errorHandler(ws: EnhancedWebSocket): void {
    ws.on('close', () => connectionManager.closeConnection(ws));
    ws.on('error', () => connectionManager.closeConnection(ws));
}

// Export both default and named for compatibility
export default p2p;
export { MessageType } from './types.js';
