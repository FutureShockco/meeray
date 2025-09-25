import { randomBytes } from 'crypto';
import dns from 'dns';
import net from 'net';
import WebSocket from 'ws';

import { chain } from '../chain.js';
import config from '../config.js';
import logger from '../logger.js';
import steem from '../steem.js';
import { P2P_CONFIG, P2P_RUNTIME_CONFIG } from './config.js';
import { SocketManager } from './socket.js';
import { EnhancedWebSocket, MessageType, P2PState } from './types.js';

export class ConnectionManager {
    private state: P2PState;
    private outgoingConnectionHandler?: (ws: EnhancedWebSocket) => void;

    constructor(state: P2PState) {
        this.state = state;
    }

    setOutgoingConnectionHandler(handler: (ws: EnhancedWebSocket) => void): void {
        this.outgoingConnectionHandler = handler;
    }

    async keepAlive(): Promise<void> {
        const toConnect: string[] = [];

        for (const peer of P2P_RUNTIME_CONFIG.PEERS) {
            let connected = false;
            const colonSplit = peer.replace('ws://', '').split(':');
            const port = parseInt(colonSplit.pop() || P2P_RUNTIME_CONFIG.P2P_PORT.toString());
            let address = colonSplit.join(':').replace(/[[\]]/g, '');

            if (!net.isIP(address)) {
                try {
                    const resolved = await dns.promises.lookup(address);
                    address = resolved.address;
                } catch (_e) {
                    logger.debug(`DNS lookup failed for ${address} ${_e}`);
                    continue;
                }
            }

            for (const socket of this.state.sockets) {
                const remoteAddress = socket._socket.remoteAddress?.replace('::ffff:', '') || '';
                const remotePort = socket._socket.remotePort;
                if (remoteAddress === address && remotePort === port) {
                    connected = true;
                    break;
                }
            }

            if (!connected) {
                toConnect.push(peer);
            }
        }

        if (toConnect.length > 0) {
            this.connect(toConnect);
        }

        setTimeout(() => this.keepAlive(), P2P_CONFIG.KEEP_ALIVE_INTERVAL);
    }

    connect(newPeers: string[], isInit: boolean = false): void {
        newPeers.forEach(peer => {
            // Skip if already connecting to this peer
            if (this.state.connectingPeers.has(peer)) {
                logger.debug(`Already connecting to peer: ${peer}`);
                return;
            }

            // Prevent self-connection by checking if peer URL points to our own port
            try {
                const peerUrl = new URL(peer);
                const peerHost = peerUrl.hostname;
                const peerPort = parseInt(peerUrl.port) || 6001;

                // Check if trying to connect to self (localhost/127.0.0.1 + our port)
                const isLocalhost = peerHost === 'localhost' || peerHost === '127.0.0.1' || peerHost === '::1';
                if (isLocalhost && peerPort === P2P_RUNTIME_CONFIG.P2P_PORT) {
                    logger.debug(`[SELF-CONNECTION] Skipping connection to self: ${peer} (our port: ${P2P_RUNTIME_CONFIG.P2P_PORT})`);
                    return;
                }
            } catch {
                logger.debug(`[SELF-CONNECTION] Invalid peer URL: ${peer}`);
                return;
            }

            // Mark as connecting
            this.state.connectingPeers.add(peer);

            const ws = new WebSocket(peer) as EnhancedWebSocket;
            ws._peerUrl = peer; // Store original URL for cleanup

            ws.on('open', () => {
                this.state.connectingPeers.delete(peer);
                // Use the outgoing connection handler if available, otherwise fallback to direct handshake
                if (this.outgoingConnectionHandler) {
                    this.outgoingConnectionHandler(ws);
                } else {
                    this.handshake(ws);
                }
            });

            ws.on('error', () => {
                this.state.connectingPeers.delete(peer);
                logger[isInit ? 'warn' : 'debug']('Peer connection failed: ' + peer);
            });

            ws.on('close', () => {
                this.state.connectingPeers.delete(peer);
            });
        });
    }

    handshake(ws: EnhancedWebSocket): void {
        if (P2P_RUNTIME_CONFIG.OFFLINE) {
            logger.warn('Incoming handshake refused: OFFLINE mode');
            ws.close();
            return;
        }

        if (this.state.sockets.length >= P2P_RUNTIME_CONFIG.MAX_PEERS) {
            logger.warn(`Incoming handshake refused: max peers ${this.state.sockets.length}/${P2P_RUNTIME_CONFIG.MAX_PEERS}`);
            ws.close();
            return;
        }

        // Check for duplicate connections
        for (const socket of this.state.sockets) {
            if (socket._socket.remoteAddress === ws._socket.remoteAddress && socket._socket.remotePort === ws._socket.remotePort) {
                ws.close();
                return;
            }
        }

        logger.debug('Handshaking new peer:', ws.url || `${ws._socket.remoteAddress}:${ws._socket.remotePort}`);

        const random = randomBytes(32).toString('hex');
        ws.challengeHash = random;

        ws.pendingDisconnect = setTimeout(() => {
            for (const socket of this.state.sockets) {
                if (socket.challengeHash === random) {
                    socket.close();
                    logger.warn('Peer did not reply to NODE_STATUS');
                }
            }
        }, P2P_CONFIG.HANDSHAKE_TIMEOUT);

        this.state.sockets.push(ws);

        // Keep SocketManager in sync
        SocketManager.setSockets(this.state.sockets);

        // Send NODE_STATUS query to initiate handshake
        SocketManager.sendJSON(ws, {
            t: MessageType.QUERY_NODE_STATUS,
            d: {
                nodeId: this.state.nodeId?.pub || '',
                random: random,
            },
        });

        // Note: messageHandler and errorHandler will be set by the main P2P module
    }

    closeConnection(ws: EnhancedWebSocket): void {
        const index = this.state.sockets.indexOf(ws);
        if (index !== -1) {
            this.state.sockets.splice(index, 1);

            // Keep SocketManager in sync
            SocketManager.setSockets(this.state.sockets);
            const currentNodeIsWitness = (global as any).consensus?.isActive() || false;
            const currentPeerCount = this.state.sockets.filter(s => s.node_status).length + (currentNodeIsWitness ? 1 : 0);
            const totalWitnesses = config.witnesses || 5;
            const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);

            logger.debug(`Peer disconnected, ${this.state.sockets.length} total peers remaining (${currentPeerCount} with node status)`);

            // Rate limiting for emergency actions
            const now = Date.now();

            // Trigger emergency actions based on consensus requirements
            if (currentPeerCount < minPeersForConsensus) {
                if (now - this.state.lastEmergencyDiscovery > P2P_CONFIG.EMERGENCY_COOLDOWN) {
                    logger.warn(`[CONNECTION] Below consensus threshold! (${currentPeerCount}/${minPeersForConsensus}) - triggering emergency discovery`);
                    this.state.lastEmergencyDiscovery = now;
                    if (steem.isInSyncMode()) {
                        logger.warn(`[CONNECTION] Exiting sync mode due to insufficient peers for consensus`);
                        const currentBlock = chain.getLatestBlock();
                        steem.exitSyncMode(currentBlock._id, currentBlock.steemBlockNum || 0);
                    }
                    // These methods will be called by the main P2P module
                    // requestPeerLists();
                    // discoveryWorker(false);
                } else {
                    logger.debug(
                        `[CONNECTION] Below consensus threshold but rate limited (last emergency ${Math.round((now - this.state.lastEmergencyDiscovery) / 1000)}s ago)`
                    );
                }
            } else if (currentPeerCount < minPeersForConsensus + 1) {
                logger.debug(`[CONNECTION] Near consensus threshold (${currentPeerCount}/${minPeersForConsensus}) - requesting peer lists`);
                // requestPeerLists() will be called by main P2P module
            }
        }
    }
}
