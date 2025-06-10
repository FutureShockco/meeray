import WebSocket, { WebSocketServer } from 'ws';
import dns from 'dns';
import net from 'net';
import { randomBytes } from 'crypto';
import secp256k1 from 'secp256k1';
import baseX from 'base-x';
import config from './config.js';
import { chain } from './chain.js';
import blocks from './blockStore.js';
import logger from './logger.js';
import cache from './cache.js';
import consensus from './consensus.js';
import steem from './steem.js';
import mongo from './mongo.js';
import { witnessesModule } from './witnesses.js';
import { getNewKeyPair } from './crypto.js';
import { Block } from './block.js';

const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

// Configuration
const version = '1.6.6';
const default_port = 6001;
const replay_interval = 1500;
const discovery_interval = 60000;
const keep_alive_interval = 2500;
const max_blocks_buffer = 100;
const max_peers = Number(process.env.MAX_PEERS) || 15;
const max_recover_attempts = 25;
const history_interval = 10000;
const keep_history_for = 20000;
const p2p_port = Number(process.env.P2P_PORT) || default_port;
const p2p_host = process.env.P2P_HOST || '::';

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
    pendingDisconnect?: NodeJS.Timeout;
    sentUs?: [string, number][];
    _peerUrl?: string;
}

export interface NodeKeyPair {
    priv: string;
    pub: string;
}

export const p2p = {
    sockets: [] as EnhancedWebSocket[],
    recoveringBlocks: [] as number[],
    recoveredBlocks: {} as Record<number, Block>,
    recovering: false as boolean | number,
    recoverAttempt: 0,
    nodeId: null as NodeKeyPair | null,
    connectingPeers: new Set<string>(),


    init: async (): Promise<void> => {
        p2p.generateNodeId();
        const server = new WebSocketServer({ host: p2p_host, port: p2p_port });
        server.on('connection', (ws: WebSocket) => p2p.handshake(ws as EnhancedWebSocket));

        logger.info('Listening websocket p2p port on: ' + p2p_port);
        logger.info('Version: ' + version);

        // Initialize recovery and refresh
        setTimeout(() => {
            p2p.recover();
            setInterval(() => p2p.refresh(), replay_interval);
        }, replay_interval);

        // Initialize discovery if enabled
        if (!process.env.NO_DISCOVERY || process.env.NO_DISCOVERY === '0') {
            setInterval(() => p2p.discoveryWorker(), discovery_interval);
            p2p.discoveryWorker(true);
        }

        // Initialize peer list requests (primary discovery method)
        setInterval(() => p2p.requestPeerLists(), 15000); // Every 15 seconds
        setTimeout(() => p2p.requestPeerLists(), 5000); // Initial delay

        // Initialize keep-alive and cleanup
        setTimeout(() => p2p.keepAlive(), keep_alive_interval);
        setInterval(() => p2p.cleanRoundConfHistory(), history_interval);
    },

    generateNodeId: (): void => {
        p2p.nodeId = getNewKeyPair();
        if (p2p.nodeId) {
            logger.info('P2P ID: ' + p2p.nodeId.pub);
        }
    },

    requestPeerLists: (): void => {
        const connectedPeers = p2p.sockets.filter(s => s.node_status);
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
            p2p.sendJSON(socket, { t: MessageType.QUERY_PEER_LIST, d: {} });
        });
    },

    discoveryWorker: async (isInit: boolean = false): Promise<void> => {
        const currentPeerCount = p2p.sockets.filter(s => s.node_status).length;
        const totalWitnesses = config.witnesses || 5;
        
        // Calculate consensus requirements
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
        const optimalPeerCount = Math.min(totalWitnesses - 1, max_peers);
        
        logger.debug(`[DISCOVERY] Current peers: ${currentPeerCount}, Min needed: ${minPeersForConsensus}, Optimal: ${optimalPeerCount}`);

        // Only use witness endpoints if we're critically low on peers or during init
        if (isInit || currentPeerCount < Math.max(1, minPeersForConsensus - 1)) {
            if (!isInit) {
                logger.warn(`[DISCOVERY] Critically low peer count! Using witness endpoints as emergency fallback`);
            }
            
            const witnesses = witnessesModule.generateWitnesses(false, true, config.witnesses * 2, 0);
            for (const witness of witnesses) {
                if (p2p.sockets.length >= max_peers) break;
                if (!witness.ws) continue;

                const excluded = process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : [];
                if (excluded.includes(witness.name)) continue;

                let isConnected = false;
                for (const socket of p2p.sockets) {
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
                    p2p.connect([witness.ws], isInit);
                }
            }
        } else {
            logger.debug(`[DISCOVERY] Relying on peer list discovery system (peer requests handle ongoing discovery)`);
        }
    },

    keepAlive: async (): Promise<void> => {
        const peers = process.env.PEERS ? process.env.PEERS.split(',') : [];
        const toConnect: string[] = [];

        for (const peer of peers) {
            let connected = false;
            const colonSplit = peer.replace('ws://', '').split(':');
            const port = parseInt(colonSplit.pop() || p2p_port.toString());
            let address = colonSplit.join(':').replace(/[\[\]]/g, '');

            if (!net.isIP(address)) {
                try {
                    const resolved = await dns.promises.lookup(address);
                    address = resolved.address;
                } catch (e) {
                    logger.debug(`DNS lookup failed for ${address}`);
                    continue;
                }
            }

            for (const socket of p2p.sockets) {
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
            p2p.connect(toConnect);
        }

        setTimeout(() => p2p.keepAlive(), keep_alive_interval);
    },

    connect: (newPeers: string[], isInit: boolean = false): void => {
        newPeers.forEach((peer) => {
            // Skip if already connecting to this peer
            if (p2p.connectingPeers.has(peer)) {
                logger.debug(`Already connecting to peer: ${peer}`);
                return;
            }

            // Mark as connecting
            p2p.connectingPeers.add(peer);

            const ws = new WebSocket(peer) as EnhancedWebSocket;
            ws._peerUrl = peer; // Store original URL for cleanup

            ws.on('open', () => {
                p2p.connectingPeers.delete(peer);
                p2p.handshake(ws);
            });

            ws.on('error', () => {
                p2p.connectingPeers.delete(peer);
                logger[isInit ? 'warn' : 'debug']('Peer connection failed: ' + peer);
            });

            ws.on('close', () => {
                p2p.connectingPeers.delete(peer);
            });
        });
    },

    handshake: (ws: EnhancedWebSocket): void => {
        if (process.env.OFFLINE) {
            logger.warn('Incoming handshake refused: OFFLINE mode');
            ws.close();
            return;
        }

        if (p2p.sockets.length >= max_peers) {
            logger.warn(`Incoming handshake refused: max peers ${p2p.sockets.length}/${max_peers}`);
            ws.close();
            return;
        }

        // Check for duplicate connections
        for (const socket of p2p.sockets) {
            if (socket._socket.remoteAddress === ws._socket.remoteAddress &&
                socket._socket.remotePort === ws._socket.remotePort) {
                ws.close();
                return;
            }
        }

        logger.debug('Handshaking new peer:', ws.url || `${ws._socket.remoteAddress}:${ws._socket.remotePort}`);

        const random = randomBytes(32).toString('hex');
        ws.challengeHash = random;

        ws.pendingDisconnect = setTimeout(() => {
            for (const socket of p2p.sockets) {
                if (socket.challengeHash === random) {
                    socket.close();
                    logger.warn('Peer did not reply to NODE_STATUS');
                }
            }
        }, 5000);

        p2p.sockets.push(ws);
        p2p.messageHandler(ws);
        p2p.errorHandler(ws);

        p2p.sendJSON(ws, {
            t: MessageType.QUERY_NODE_STATUS,
            d: {
                nodeId: p2p.nodeId?.pub || '',
                random: random
            }
        });
    },

    messageHandler: (ws: EnhancedWebSocket): void => {
        ws.on('message', (data: WebSocket.Data) => {
            let message: any;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                logger.warn('P2P received non-JSON data');
                return;
            }

            if (!message || typeof message.t === 'undefined' || !message.d) return;

            switch (message.t) {
                case MessageType.QUERY_NODE_STATUS:
                    p2p.handleNodeStatusQuery(ws, message);
                    break;

                case MessageType.NODE_STATUS:
                    p2p.handleNodeStatus(ws, message);
                    break;

                case MessageType.QUERY_BLOCK:
                    p2p.handleBlockQuery(ws, message);
                    break;

                case MessageType.BLOCK:
                    p2p.handleBlock(ws, message);
                    break;

                case MessageType.NEW_BLOCK:
                    p2p.handleNewBlock(ws, message);
                    break;


                case MessageType.BLOCK_CONF_ROUND:
                    p2p.handleBlockConfRound(ws, message);
                    break;

                case MessageType.STEEM_SYNC_STATUS:
                    p2p.handleSteemSyncStatus(ws, message);
                    break;

                case MessageType.QUERY_PEER_LIST:
                    p2p.handlePeerListQuery(ws, message);
                    break;

                case MessageType.PEER_LIST:
                    p2p.handlePeerList(ws, message);
                    break;
            }
        });
    },

    handleNodeStatusQuery: (ws: EnhancedWebSocket, message: any): void => {
        if (typeof message.d?.nodeId !== 'string' || typeof message.d?.random !== 'string') return;

        const wsNodeId = message.d.nodeId;
        if (wsNodeId === p2p.nodeId?.pub) {
            logger.debug('Peer disconnected: same P2P ID');
            ws.close();
            return;
        }

        const wsIndex = p2p.sockets.indexOf(ws);
        if (wsIndex !== -1) {
            p2p.sockets[wsIndex].node_status = {
                nodeId: message.d.nodeId,
                head_block: 0,
                head_block_hash: '',
                previous_block_hash: '',
                origin_block: '',
                version: ''
            };
        }

        if (!p2p.nodeId) return;

        const signature = secp256k1.ecdsaSign(
            Buffer.from(message.d.random, 'hex'),
            bs58.decode(p2p.nodeId.priv)
        );
        const signatureStr = bs58.encode(signature.signature);

        const latestBlock = chain.getLatestBlock();
        const responseData = {
            origin_block: config.originHash,
            head_block: latestBlock._id,
            head_block_hash: latestBlock.hash,
            previous_block_hash: latestBlock.phash,
            nodeId: p2p.nodeId.pub,
            version: version,
            sign: signatureStr
        };

        p2p.sendJSON(ws, { t: MessageType.NODE_STATUS, d: responseData });
    },

    handleNodeStatus: (ws: EnhancedWebSocket, message: any): void => {
        if (typeof message.d?.sign !== 'string') return;

        const wsIndex = p2p.sockets.indexOf(ws);
        if (wsIndex === -1) return;

        const nodeId = p2p.sockets[wsIndex].node_status?.nodeId;
        if (!message.d.nodeId || message.d.nodeId !== nodeId) return;

        const challengeHash = p2p.sockets[wsIndex].challengeHash;
        if (!challengeHash) return;

        if (message.d.origin_block !== config.originHash) {
            logger.debug('Different chain ID, disconnecting');
            ws.close();
            return;
        }

        try {
            const isValidSignature = secp256k1.ecdsaVerify(
                bs58.decode(message.d.sign),
                Buffer.from(challengeHash, 'hex'),
                bs58.decode(nodeId || '')
            );

            if (!isValidSignature) {
                logger.warn('Wrong NODE_STATUS signature, disconnecting');
                ws.close();
                return;
            }

            // Remove duplicate connections
            for (let i = 0; i < p2p.sockets.length; i++) {
                if (i !== wsIndex &&
                    p2p.sockets[i].node_status &&
                    p2p.sockets[i].node_status?.nodeId === nodeId) {
                    logger.debug('Peer disconnected: duplicate connection');
                    p2p.sockets[i].close();
                }
            }

            if (p2p.sockets[wsIndex].pendingDisconnect) {
                clearTimeout(p2p.sockets[wsIndex].pendingDisconnect);
            }

            delete message.d.sign;
            p2p.sockets[wsIndex].node_status = message.d;

        } catch (error) {
            logger.error('Error during NODE_STATUS verification:', error);
        }
    },

    handleBlockQuery: async (ws: EnhancedWebSocket, message: any): Promise<void> => {
        const blockId = message.d;
        if (typeof blockId !== 'number') {
            logger.warn('Invalid block ID type:', typeof blockId);
            return;
        }

        let block = null;

        // Try blocks store first
        if (blocks.isOpen) {
            try {
                block = blocks.read(blockId);
                p2p.sendJSON(ws, { t: MessageType.BLOCK, d: block });
                return;
            } catch (e) {
                logger.warn('Block', blockId, 'not found in blocks store, trying MongoDB');
            }
        } else {
            // Fallback to MongoDB
            try {
                if (mongo.getDb) {
                    const db = mongo.getDb();
                    block = await db.collection('blocks').findOne({ _id: blockId } as any);
                    if (block) {
                        p2p.sendJSON(ws, { t: MessageType.BLOCK, d: block });
                    } else {
                        console.warn('Block', blockId, 'not found in MongoDB either');
                    }
                }
            } catch (mongoError: any) {
                logger.warn('MongoDB query failed for block', blockId, ':', mongoError.message);
            }
        }


    },

    handleBlock: (ws: EnhancedWebSocket, message: any): void => {
        const block = message.d;

        if (!block?._id || !p2p.recoveringBlocks.includes(block._id)) {
            logger.warn('Ignoring block - not in recovering list');
            return;
        }

        const index = p2p.recoveringBlocks.indexOf(block._id);
        if (index !== -1) {
            p2p.recoveringBlocks.splice(index, 1);
        }

        const currentHead = chain.getLatestBlock()._id;

        if (currentHead + 1 === block._id) {
            p2p.addRecursive(block);
        } else {
            p2p.recoveredBlocks[block._id] = block;
            p2p.recover();
        }
    },

    handleNewBlock: (ws: EnhancedWebSocket, message: any): void => {
        const block = message.d;
        if (!block) return;

        const wsIndex = p2p.sockets.indexOf(ws);
        if (wsIndex === -1 || !p2p.sockets[wsIndex].node_status) return;

        // Update peer status
        p2p.sockets[wsIndex].node_status!.head_block = block._id;
        p2p.sockets[wsIndex].node_status!.head_block_hash = block.hash;
        p2p.sockets[wsIndex].node_status!.previous_block_hash = block.phash;

        if (p2p.recovering) return;

        consensus.round(0, block);
    },

    handleNewTransaction: (ws: EnhancedWebSocket, message: any): void => {
        if (p2p.recovering) return;

        const tx = message.d;
        // Note: transaction validation would go here
        // Simplified for this implementation
    },

    handleBlockConfRound: (ws: EnhancedWebSocket, message: any): void => {
        if (p2p.recovering) return;
        if (!message.s?.s || !message.s?.n || !message.d?.ts) return;

        const now = Date.now();
        if (message.d.ts + 2 * config.blockTime < now ||
            message.d.ts - 2 * config.blockTime > now) return;

        const wsIndex = p2p.sockets.indexOf(ws);
        if (wsIndex !== -1) {
            if (!p2p.sockets[wsIndex].sentUs) {
                p2p.sockets[wsIndex].sentUs = [];
            }
            p2p.sockets[wsIndex].sentUs!.push([message.s.s, now]);
        }

        // Check if already processed
        for (const processed of consensus.processed || []) {
            if (processed[0]?.s?.s === message.s.s) return;
        }

        // Add to processed list
        if (!consensus.processed) consensus.processed = [];
        consensus.processed.push([message, now]);

        // Broadcast to other peers
        p2p.broadcastNotSent(message);

        // Process in consensus
        consensus.round(0, message.d.b, (validationStep: number) => {
            if (validationStep === 0) {
                if (!consensus.queue) consensus.queue = [];
                consensus.queue.push(message);
            } else if (validationStep > 0) {
                consensus.remoteRoundConfirm(message);
            }
        });
    },

    handleSteemSyncStatus: (ws: EnhancedWebSocket, message: any): void => {
        const syncStatus = message.d as SteemSyncStatus;
        if (!syncStatus?.nodeId || typeof syncStatus.behindBlocks !== 'number') return;

        // Store sync status for this peer
        ws.steemSyncStatus = syncStatus;

        // Forward to steem module for processing
        if (steem.receivePeerSyncStatus) {
            steem.receivePeerSyncStatus(syncStatus.nodeId, syncStatus);
        }

        // Relay to other peers if not already relayed
        if (!syncStatus.relayed) {
            const relayedMessage = {
                ...message,
                d: { ...syncStatus, relayed: true }
            };

            for (const socket of p2p.sockets) {
                if (socket !== ws && socket.node_status?.nodeId !== syncStatus.nodeId) {
                    p2p.sendJSON(socket, relayedMessage);
                }
            }
        }
    },

    handlePeerListQuery: (ws: EnhancedWebSocket, message: any): void => {
        const knownPeers: string[] = [];

        // Add currently connected peers
        p2p.sockets
            .filter(socket => socket !== ws && socket.node_status?.nodeId && socket._socket?.remoteAddress)
            .forEach(socket => {
                const address = socket._socket.remoteAddress.replace('::ffff:', '');
                const port = socket._socket.remotePort || p2p_port;
                const peerUrl = `ws://${address}:${port}`;
                if (!knownPeers.includes(peerUrl)) {
                    knownPeers.push(peerUrl);
                }
            });

        // Add peers from environment (bootstrap peers)
        const envPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];
        envPeers.forEach(peer => {
            if (!knownPeers.includes(peer)) {
                knownPeers.push(peer);
            }
        });

        // Add witness endpoints we know about
        try {
            const witnesses = witnessesModule.generateWitnesses(false, true, Math.min(config.witnesses * 2, 10), 0);
            witnesses.forEach(witness => {
                if (witness.ws && !knownPeers.includes(witness.ws)) {
                    knownPeers.push(witness.ws);
                }
            });
        } catch (e) {
            // Ignore witness generation errors
        }

        logger.debug(`Sending peer list with ${knownPeers.length} peers to requesting peer`);

        p2p.sendJSON(ws, {
            t: MessageType.PEER_LIST,
            d: { peers: knownPeers }
        });
    },

    handlePeerList: (ws: EnhancedWebSocket, message: any): void => {
        const receivedPeers: string[] = message.d?.peers || [];
        if (!Array.isArray(receivedPeers)) return;

        const currentPeerCount = p2p.sockets.filter(s => s.node_status).length;
        const totalWitnesses = config.witnesses || 5;
        const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
        const optimalPeerCount = Math.min(totalWitnesses - 1, max_peers);
        
        logger.debug(`[PEER_LIST] Received ${receivedPeers.length} peers. Current: ${currentPeerCount}, Min needed: ${minPeersForConsensus}, Optimal: ${optimalPeerCount}`);

        // Calculate how many new peers we need based on consensus requirements
        let maxNewPeers = 0;
        if (currentPeerCount < minPeersForConsensus) {
            // Emergency: try to reach minimum consensus
            maxNewPeers = Math.min(minPeersForConsensus - currentPeerCount + 2, max_peers - p2p.sockets.length);
            logger.warn(`[PEER_LIST] Below consensus threshold! Attempting to connect to ${maxNewPeers} new peers`);
        } else if (currentPeerCount < optimalPeerCount) {
            // Normal: try to reach optimal
            maxNewPeers = Math.min(optimalPeerCount - currentPeerCount, 3);
            logger.debug(`[PEER_LIST] Below optimal, attempting to connect to ${maxNewPeers} new peers`);
        } else {
            // We have enough peers, be conservative
            maxNewPeers = Math.max(0, max_peers - p2p.sockets.length);
            if (maxNewPeers > 0) {
                logger.debug(`[PEER_LIST] Peer count optimal, will connect to ${maxNewPeers} additional peers if slots available`);
            } else {
                logger.debug(`[PEER_LIST] Peer count optimal and at max capacity`);
                return;
            }
        }

        // Filter and prioritize new peers
        const peersToConnect = receivedPeers.filter(peerUrl => {
            try {
                const url = new URL(peerUrl);
                const peerHost = url.hostname;
                const peerPort = parseInt(url.port) || 6001;

                // Check if already connecting
                if (p2p.connectingPeers.has(peerUrl)) {
                    return false;
                }

                // Check if already connected
                const alreadyConnected = p2p.sockets.some(socket => {
                    if (socket._socket?.remoteAddress && socket._socket?.remotePort) {
                        const remoteAddr = socket._socket.remoteAddress.replace('::ffff:', '');
                        const remotePort = socket._socket.remotePort;
                        return remoteAddr === peerHost && remotePort === peerPort;
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
            logger.info(`[PEER_LIST] Connecting to ${peersToConnect.length} new peers for consensus: ${peersToConnect.join(', ')}`);
            p2p.connect(peersToConnect);
        } else {
            logger.debug('[PEER_LIST] No suitable new peers to connect to');
        }
    },

    // Core P2P functions
    recover: (): void => {
        if (!p2p.sockets.length) return;
        if (Object.keys(p2p.recoveredBlocks).length + p2p.recoveringBlocks.length > max_blocks_buffer) return;

        if (!p2p.recovering) {
            p2p.recovering = chain.getLatestBlock()._id;
        }

        const currentBlock = chain.getLatestBlock()._id;
        logger.debug('Current block:', currentBlock);
        logger.debug('Origin hash:', config.originHash);

        // Debug each socket's status
        p2p.sockets.forEach((socket, index) => {
            logger.debug(`Peer ${index}:`, {
                hasNodeStatus: !!socket.node_status,
                headBlock: socket.node_status?.head_block,
                originBlock: socket.node_status?.origin_block,
                isAhead: socket.node_status ? socket.node_status.head_block > currentBlock : false,
                originMatches: socket.node_status?.origin_block === config.originHash
            });
        });

        const peersAhead = p2p.sockets.filter(socket =>
            socket.node_status &&
            socket.node_status.head_block > chain.getLatestBlock()._id &&
            socket.node_status.origin_block === config.originHash
        );


        if (peersAhead.length === 0) {
            p2p.recovering = false;
            return;
        }

        const champion = peersAhead[Math.floor(Math.random() * peersAhead.length)];
        const nextBlock = (p2p.recovering as number) + 1;


        if (nextBlock <= champion.node_status!.head_block) {
            p2p.recovering = nextBlock;
            p2p.sendJSON(champion, { t: MessageType.QUERY_BLOCK, d: nextBlock });
            p2p.recoveringBlocks.push(nextBlock);

            logger.debug(`Querying block #${nextBlock} from peer (head: ${champion.node_status!.head_block})`);

            if (nextBlock % 2) {
                p2p.recover();
            }
        } else {
            logger.warn('Next block exceeds peer head block');
        }
    },

    refresh: (force: boolean = false): void => {
        if (p2p.recovering && !force) return;

        for (const socket of p2p.sockets) {
            if (socket.node_status &&
                socket.node_status.head_block > chain.getLatestBlock()._id + 10 &&
                socket.node_status.origin_block === config.originHash) {

                logger.info(`Catching up with network, peer head block: ${socket.node_status.head_block}`);
                p2p.recovering = chain.getLatestBlock()._id;
                p2p.recover();
                break;
            }
        }
    },

    addRecursive: (block: Block): void => {
        chain.validateAndAddBlock(block, true, (err: any, newBlock: Block | null) => {
            if (err) {
                cache.rollback();
                p2p.recoveredBlocks = {};
                p2p.recoveringBlocks = [];
                p2p.recoverAttempt++;

                if (p2p.recoverAttempt > max_recover_attempts) {
                    logger.error(`Error Replay: exceeded max attempts for block ${block._id}`);
                } else {
                    logger.warn(`Recover attempt #${p2p.recoverAttempt} for block ${block._id}`);
                    p2p.recovering = chain.getLatestBlock()._id;
                    p2p.recover();
                }
            } else {
                p2p.recoverAttempt = 0;
                if (newBlock) {
                    delete p2p.recoveredBlocks[newBlock._id];
                }
                p2p.recover();

                // Process next block if available
                const nextBlockId = chain.getLatestBlock()._id + 1;
                if (p2p.recoveredBlocks[nextBlockId]) {
                    setTimeout(() => {
                        if (p2p.recoveredBlocks[nextBlockId]) {
                            p2p.addRecursive(p2p.recoveredBlocks[nextBlockId]);
                        }
                    }, 1);
                }
            }
        });
    },

    // Communication functions
    errorHandler: (ws: EnhancedWebSocket): void => {
        ws.on('close', () => p2p.closeConnection(ws));
        ws.on('error', () => p2p.closeConnection(ws));
    },

    closeConnection: (ws: EnhancedWebSocket): void => {
        const index = p2p.sockets.indexOf(ws);
        if (index !== -1) {
            p2p.sockets.splice(index, 1);
            const currentPeerCount = p2p.sockets.filter(s => s.node_status).length;
            const totalWitnesses = config.witnesses || 5;
            const minPeersForConsensus = Math.ceil(totalWitnesses * 0.6);
            
            logger.debug(`Peer disconnected, ${p2p.sockets.length} total peers remaining (${currentPeerCount} with node status)`);

            // Trigger emergency actions based on consensus requirements
            if (currentPeerCount < minPeersForConsensus) {
                logger.warn(`[CONNECTION] Below consensus threshold! (${currentPeerCount}/${minPeersForConsensus}) - triggering emergency discovery`);
                
                // Immediate peer list request to remaining peers
                p2p.requestPeerLists();
                
                // Trigger discovery worker after short delay
                setTimeout(() => {
                    p2p.discoveryWorker(false);
                }, 1000);
            } else if (currentPeerCount < (minPeersForConsensus + 1)) {
                logger.warn(`[CONNECTION] Near consensus threshold (${currentPeerCount}/${minPeersForConsensus}) - requesting peer lists`);
                p2p.requestPeerLists();
            }
        }
    },

    sendJSON: (ws: EnhancedWebSocket, data: any): void => {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
            logger.warn('Failed to send P2P message:', error);
        }
    },

    broadcast: (data: any): void => {
        p2p.sockets.forEach(ws => p2p.sendJSON(ws, data));
    },

    broadcastNotSent: (data: any): void => {
        for (const socket of p2p.sockets) {
            if (!socket.sentUs) {
                p2p.sendJSON(socket, data);
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
                p2p.sendJSON(socket, data);
            }
        }
    },

    broadcastBlock: (block: Block): void => {
        p2p.broadcast({ t: MessageType.NEW_BLOCK, d: block });
    },

    broadcastSyncStatus: (syncStatus: SteemSyncStatus): void => {
        p2p.broadcast({ t: MessageType.STEEM_SYNC_STATUS, d: syncStatus });
    },

    cleanRoundConfHistory: (): void => {
        const now = Date.now();
        for (const socket of p2p.sockets) {
            if (!socket.sentUs) continue;

            for (let i = socket.sentUs.length - 1; i >= 0; i--) {
                if (now - socket.sentUs[i][1] > keep_history_for) {
                    socket.sentUs.splice(i, 1);
                }
            }
        }
    }
};

export default p2p; 