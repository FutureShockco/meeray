import logger from '../logger.js';
import config from '../config.js';
import consensus from '../consensus.js';
import { chain } from '../chain.js';
import { witnessesModule } from '../witnesses.js';
import { EnhancedWebSocket, P2PState, MessageType } from './types.js';
import { P2P_CONFIG, P2P_RUNTIME_CONFIG } from './config.js';
import { SocketManager } from './socket.js';

export class PeerDiscovery {
    private state: P2PState;
    private connect: (peers: string[], isInit?: boolean) => void;

    constructor(
        state: P2PState, 
        connect: (peers: string[], isInit?: boolean) => void
    ) {
        this.state = state;
        this.connect = connect;
    }

    requestPeerLists(): void {
        const connectedPeers = SocketManager.getSocketsWithStatus();
        const currentPeerCount = connectedPeers.length;
        const totalWitnesses = config.witnesses || 5;
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);

        if (connectedPeers.length === 0) {
            logger.debug('[PEER_REQUEST] No connected peers to request peer lists from');
            return;
        }

        // Request peer lists more aggressively if below consensus threshold
        const shouldRequestAll = currentPeerCount < minPeersForConsensus;
        const peersToQuery = shouldRequestAll ? connectedPeers : connectedPeers.slice(0, Math.max(1, Math.ceil(connectedPeers.length / 2)));

        logger.debug(`[PEER_REQUEST] Requesting peer lists from ${peersToQuery.length}/${connectedPeers.length} peers (current: ${currentPeerCount}, min needed: ${minPeersForConsensus})`);

        peersToQuery.forEach(socket => {
            SocketManager.sendJSON(socket, { t: MessageType.QUERY_PEER_LIST, d: {} });
        });
    }

    async discoveryWorker(isInit: boolean = false): Promise<void> {
        const currentPeerCount = SocketManager.getSocketsWithStatus().length;
        const totalWitnesses = config.witnesses || 5;

        // Calculate consensus requirements
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
        const optimalPeerCount = Math.min(totalWitnesses - 1, P2P_RUNTIME_CONFIG.MAX_PEERS);

        // Rate limiting for non-init calls
        const now = Date.now();
        if (!isInit && now - this.state.lastEmergencyDiscovery < P2P_CONFIG.RATE_LIMIT_EMERGENCY) {
            logger.debug(`[DISCOVERY] Rate limited - last emergency discovery ${Math.round((now - this.state.lastEmergencyDiscovery) / 1000)}s ago`);
            return;
        }

        logger.debug(`[DISCOVERY] Current peers: ${currentPeerCount}, Min needed: ${minPeersForConsensus}, Optimal: ${optimalPeerCount}`);

        // Only use witness endpoints if we're critically low on peers or during init
        if (isInit || currentPeerCount < Math.max(1, minPeersForConsensus - 1)) {
            if (!isInit) {
                logger.warn(`[DISCOVERY] Critically low peer count (${currentPeerCount})! Using witness endpoints as emergency fallback`);
                this.state.lastEmergencyDiscovery = now;
            }
            const block = chain.getLatestBlock();
            const witnesses = witnessesModule.generateWitnesses(false, config.read(block._id).witnesses, 0);
            for (const witness of witnesses) {
                if (SocketManager.getSocketCount() >= P2P_RUNTIME_CONFIG.MAX_PEERS) break;
                if (!witness.ws) continue;

                if (P2P_RUNTIME_CONFIG.DISCOVERY_EXCLUDE.includes(witness.name)) continue;

                let isConnected = false;
                for (const socket of SocketManager.getSockets()) {
                    try {
                        const witnessIp = witness.ws.split('://')[1].split(':')[0];
                        const socketIp = socket._socket.remoteAddress?.replace('::ffff:', '') || '';
                        if (witnessIp === socketIp) {
                            isConnected = true;
                            break;
                        }
                    } catch (error) {
                        logger.debug(`Invalid ws for witness ${witness.name}: ${witness.ws}`);
                    }
                }

                if (!isConnected) {
                    logger[isInit ? 'info' : 'warn'](`[DISCOVERY] Connecting to witness ${witness.name} at ${witness.ws} (${isInit ? 'init' : 'emergency'})`);
                    this.connect([witness.ws], isInit);
                }
            }
        } else {
            logger.debug(`[DISCOVERY] Peer count acceptable (${currentPeerCount}), relying on peer list discovery system`);
        }
    }

    handlePeerListQuery(ws: EnhancedWebSocket, message: any): void {
        const knownPeers: string[] = [];

        // Add currently connected peers
        this.state.sockets
            .filter(socket => socket !== ws && socket.node_status?.nodeId && socket._socket?.remoteAddress)
            .forEach(socket => {
                const address = socket._socket.remoteAddress.replace('::ffff:', '');
                const port = socket._socket.remotePort || P2P_RUNTIME_CONFIG.P2P_PORT;
                const peerUrl = `ws://${address}:${port}`;
                if (!knownPeers.includes(peerUrl)) {
                    knownPeers.push(peerUrl);
                }
            });

        // Add peers from environment (bootstrap peers)
        P2P_RUNTIME_CONFIG.PEERS.forEach(peer => {
            if (!knownPeers.includes(peer)) {
                knownPeers.push(peer);
            }
        });

        // Add witness endpoints we know about
        try {
            const block = chain.getLatestBlock();
            const witnesses = witnessesModule.generateWitnesses(false, config.read(block._id).witnesses, 0);
            witnesses.forEach(witness => {
                if (witness.ws && !knownPeers.includes(witness.ws)) {
                    knownPeers.push(witness.ws);
                }
            });
        } catch (e) {
            // Ignore witness generation errors
        }

        logger.debug(`Sending peer list with ${knownPeers.length} peers to requesting peer`);

        SocketManager.sendJSON(ws, {
            t: MessageType.PEER_LIST,
            d: { peers: knownPeers }
        });
    }

    handlePeerList(ws: EnhancedWebSocket, message: any): void {
        const receivedPeers: string[] = message.d?.peers || [];
        if (!Array.isArray(receivedPeers)) return;

        const connectedPeerCount = this.state.sockets.filter(s => s.node_status).length;
        // Include current node in consensus count if it's an active witness
        const currentNodeIsWitness = consensus.isActive();
        const currentPeerCount = connectedPeerCount + (currentNodeIsWitness ? 1 : 0);
        const totalWitnesses = config.witnesses || 5;
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
        const optimalPeerCount = Math.min(totalWitnesses - 1, P2P_RUNTIME_CONFIG.MAX_PEERS);

        logger.debug(`[PEER_LIST] Received ${receivedPeers.length} peers. Current: ${currentPeerCount}, Min needed: ${minPeersForConsensus}, Optimal: ${optimalPeerCount}`);

        // Rate limiting: avoid connection spam 
        const now = Date.now();
        const isEmergency = currentPeerCount < minPeersForConsensus;
        const cooldownPeriod = isEmergency ? P2P_CONFIG.RATE_LIMIT_EMERGENCY : P2P_CONFIG.RATE_LIMIT_NORMAL;

        if (now - this.state.lastPeerListConnection < cooldownPeriod) {
            logger.debug(`[PEER_LIST] Rate limited - last connection attempt ${Math.round((now - this.state.lastPeerListConnection) / 1000)}s ago`);
            return;
        }

        // Calculate how many new peers we need based on consensus requirements
        let maxNewPeers = 0;
        if (isEmergency) {
            maxNewPeers = Math.min(minPeersForConsensus - currentPeerCount + 1, P2P_RUNTIME_CONFIG.MAX_PEERS - this.state.sockets.length);
            logger.warn(`[PEER_LIST] Below consensus threshold! (${currentPeerCount}/${minPeersForConsensus}) - attempting to connect to ${maxNewPeers} new peers`);
        } else if (currentPeerCount < optimalPeerCount) {
            maxNewPeers = Math.min(optimalPeerCount - currentPeerCount, 2);
            logger.debug(`[PEER_LIST] Below optimal, attempting to connect to ${maxNewPeers} new peers`);
        } else {
            maxNewPeers = Math.max(0, Math.min(1, P2P_RUNTIME_CONFIG.MAX_PEERS - this.state.sockets.length));
            if (maxNewPeers > 0) {
                logger.debug(`[PEER_LIST] Peer count optimal, will connect to ${maxNewPeers} additional peer if slot available`);
            } else {
                logger.debug(`[PEER_LIST] Peer count optimal and at capacity`);
                return;
            }
        }

        // Filter and prioritize new peers
        const peersToConnect = receivedPeers.filter(peerUrl => {
            try {
                const url = new URL(peerUrl);
                const peerHost = url.hostname;

                // Check if already connecting
                if (this.state.connectingPeers.has(peerUrl)) {
                    return false;
                }

                // Check if already connected (compare by IP only, since remotePort is ephemeral)
                const alreadyConnected = this.state.sockets.some(socket => {
                    if (socket._socket?.remoteAddress) {
                        const remoteAddr = socket._socket.remoteAddress.replace('::ffff:', '');
                        return remoteAddr === peerHost;
                    }
                    return false;
                });

                return !alreadyConnected;

            } catch (e) {
                logger.debug(`[PEER_LIST] Invalid peer URL: ${peerUrl}`);
                return false;
            }
        })
        .slice(0, maxNewPeers) // Limit based on consensus needs
        .sort(() => Math.random() - 0.5); // Randomize to distribute load

        if (peersToConnect.length > 0) {
            this.state.lastPeerListConnection = now;

            // Reconstruct URLs to use proper P2P port instead of ephemeral ports
            const properPeerUrls = peersToConnect.map(peerUrl => {
                try {
                    const url = new URL(peerUrl);
                    return `ws://${url.hostname}:${P2P_RUNTIME_CONFIG.P2P_PORT}`;
                } catch (e) {
                    return peerUrl; // fallback to original if parsing fails
                }
            });

            logger.info(`[PEER_LIST] Connecting to ${properPeerUrls.length} new peers: ${properPeerUrls.join(', ')}`);
            this.connect(properPeerUrls);
        } else {
            logger.debug('[PEER_LIST] No suitable new peers to connect to');
        }
    }
}
