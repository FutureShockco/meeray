import WebSocket from 'ws';
import dns from 'dns';
import net from 'net';
import { randomBytes } from 'crypto';
import secp256k1 from 'secp256k1';
import baseX from 'base-x';
import config from './config.js';
import { chain } from './chain.js';
import blocks from './blockStore.js';
import { Block } from './block.js';
import logger from './logger.js';
import cache from './cache.js';
import consensus from './consensus.js';
import steem from './steem.js';
import witnessesModule from './witnesses.js';
import { getNewKeyPair, verifySignature } from './crypto.js';
import mongo from './mongo.js';
import ip from 'ip';

const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');


const version = '1.6.6';
const default_port = 6001;
const replay_interval = 5000;
const discovery_interval = 60000;
const keep_alive_interval = 10000;
const max_blocks_buffer = 100;
const max_peers = Number(process.env.MAX_PEERS) || 15;
const max_recover_attempts = 25;
const history_interval = 10000;
const keep_history_for = 20000;
const p2p_port = Number(process.env.P2P_PORT) || default_port;
const p2p_host = process.env.P2P_HOST || '::';

// Constants for peer query
const PEER_QUERY_BASE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PEER_QUERY_JITTER = 30 * 1000; // 30 seconds

export enum MessageType {
    QUERY_NODE_STATUS = 0,
    NODE_STATUS = 1,
    QUERY_BLOCK = 2,
    BLOCK = 3,
    NEW_BLOCK = 4,
    BLOCK_CONF_ROUND = 5,
    STEEM_SYNC_STATUS = 6,
    QUERY_BLOCKS = 7,
    BLOCKS = 8,
    QUERY_PEER_LIST = 9,
    PEER_LIST = 10
}


export interface NodeStatus {
    nodeId: string;
    head_block: number;
    head_block_hash: string;
    previous_block_hash: string;
    origin_block: string;
    version: string;
    sign?: string;
    is_witness?: boolean;
    node_type?: string;
}

export interface EnhancedWebSocket extends WebSocket {
    _socket: net.Socket;
    _peerUrl?: string;  // custom property for peer URL
    challengeHash?: string;
    pendingDisconnect?: NodeJS.Timeout;
    node_status?: NodeStatus;
    sentUs?: [string, number][];
    steemSyncStatus?: SteemSyncStatus;
    isConnectedTo?: (address: string) => boolean;
    peerQueryIntervalId?: NodeJS.Timeout; // For recurring peer list query
}

export interface SteemSyncStatus {
    nodeId: string;
    behindBlocks: number;
    isSyncing: boolean;
    timestamp: number;
    steemBlock?: number;
    blockId?: number;
    consensusBlocks?: number;
    isInWarmup?: boolean;
}


export interface NodeKeyPair {
    priv: string;
    pub: string;
}

const pendingBlockRequests = new Set<number>();
const blockRequestRetries = new Map<number, { attempts: number, triedPeers: Set<string> }>();
const MAX_BLOCK_RETRIES = 5;


interface RetryInfo {
    attempts: number;
    lastAttempt: number; // timestamp
}

function normalizeWsUrl(url: string): string {
    const protocolMatch = url.match(/^(ws:\/\/|wss:\/\/)/i);
    if (!protocolMatch) return url;

    const protocol = protocolMatch[1];
    let rest = url.slice(protocol.length);

    // If IPv6 literal without brackets (i.e. multiple colons in address part)
    // wrap the address in brackets before the port
    const lastColonIndex = rest.lastIndexOf(':');
    if (lastColonIndex === -1) return url;

    const addressPart = rest.substring(0, lastColonIndex);
    const portPart = rest.substring(lastColonIndex + 1);

    if (addressPart.includes(':') && !addressPart.startsWith('[')) {
        rest = `[${addressPart}]` + ':' + portPart;
    }

    return protocol + rest;
}

export const p2p = {
    sockets: [] as EnhancedWebSocket[],
    recoveringBlocks: [] as number[],
    recoveredBlocks: {} as Record<number, Block>,
    recovering: false as boolean | number,
    recoverAttempt: 0,
    nodeId: null as NodeKeyPair | null,
    recentConnectionAttempts: {} as Record<string, RetryInfo>,
    pendingConnections: new Set<string>(),
    isConnectedTo(address: string) {
        return this.sockets.some(ws => {
            const peerUrl = (ws as EnhancedWebSocket)._peerUrl || `ws://${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
            return peerUrl === address;
        });
    },
    init: async (): Promise<void> => {
        p2p.generateNodeId();
        logger.debug(`[P2P:init] P2P module initialized. Max peers: ${max_peers}. Listening on ${p2p_host}:${p2p_port}`);

        // Dynamically import the 'ws' module
        const wsModule = await import('ws');

        // Use type assertions to access untyped properties safely
        const WebSocketServer =
            (wsModule as any).WebSocketServer ||
            (wsModule as any).Server ||
            (wsModule.default as any)?.WebSocketServer ||
            (wsModule.default as any)?.Server;

        // Optional: throw if not found
        if (!WebSocketServer) {
            throw new Error('WebSocketServer not found in ws module');
        }

        // Create server
        const server = new WebSocketServer({ host: p2p_host, port: p2p_port });

        server.on('connection', (ws: WebSocket) => p2p.handshake(ws as EnhancedWebSocket));
        logger.info('Listening websocket p2p port on: ' + p2p_port);
        logger.info('Version: ' + version);

        // Delay initial recovery to allow time for initial connections
        setTimeout(() => {
            // Set up recovery on a slower schedule
            p2p.recover();
            // Use a longer initial delay before starting regular refresh schedule
            setTimeout(() => {
                setInterval(() => p2p.refresh(), replay_interval);
            }, replay_interval * 2); // 30 seconds initial delay
        }, 5000); // Double the standard replay interval for startup

        if (!process.env.NO_DISCOVERY || process.env.NO_DISCOVERY === '0' || process.env.NO_DISCOVERY === '0') {
            // Delay initial discovery to spread out startup operations
            setTimeout(() => {
                setInterval(() => p2p.discoveryWorker(), discovery_interval);
                p2p.discoveryWorker(true);
            }, 5000); // 5 seconds delay
        }

        // Spread out operation schedules
        setTimeout(() => {
            setInterval(() => p2p.cleanRoundConfHistory(), history_interval);
        }, 15000); // 15 seconds delay
    },

    generateNodeId: (): void => {
        p2p.nodeId = getNewKeyPair();
        logger.info('P2P ID: ' + p2p.nodeId.pub);
    },

    discoveryWorker: async (isInit: boolean = false): Promise<void> => {
        const configBlock = config.read(0);
        const maxPeers = max_peers;

        let witnesses = witnessesModule.generateWitnesses(false, true, configBlock.witnesses * 3, 0);
        if (!Array.isArray(witnesses) || witnesses.length === 0) {
            logger.warn('No witnesses found for discovery.');
            return;
        }

        const excluded = process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : [];

        for (const witness of witnesses) {
            if (p2p.sockets.length >= maxPeers) {
                logger.debug(`Max peers reached: ${p2p.sockets.length}/${maxPeers}`);
                break;
            }

            if (!witness.ws || excluded.includes(witness.name)) continue;

            let isConnected = false;

            let witnessHost: string;
            try {
                witnessHost = new URL(witness.ws).hostname;
            } catch (e) {
                logger.debug(`Invalid witness ws url: ${witness.ws} for witness ${witness.name}`, e);
                continue;
            }

            for (const socket of p2p.sockets) {
                let ip = socket._socket?.remoteAddress || '';
                if (ip.startsWith('::ffff:')) ip = ip.slice(7);

                if (ip === witnessHost) {
                    logger.warn(`Already connected to witness ${witness.name} (${witness.ws})`);
                    isConnected = true;
                    break;
                }

                try {
                    // In case witnessHost is a hostname, resolve it to IP
                    const resolved = await dns.promises.lookup(witnessHost);
                    if (resolved.address === ip) {
                        logger.warn(`Already connected to witness ${witness.name} (${witness.ws})`);
                        isConnected = true;
                        break;
                    }
                } catch (e) {
                    logger.debug(`DNS resolution failed for ${witnessHost}: ${e instanceof Error ? e.message : e}`);
                }
            }

            if (!isConnected) {
                logger[isInit ? 'info' : 'debug'](`Connecting to witness ${witness.name} at ${witness.ws}`);
                p2p.connect([witness.ws], isInit);
            }
        }
    },

    keepAlive: async (): Promise<void> => {
        logger.debug(`[P2P:keepAlive] Entered. Current sockets: ${p2p.sockets.length}/${max_peers}`);
        if (p2p.sockets.length >= max_peers) {
            logger.debug(`[P2P:keepAlive] Already at max peers (${p2p.sockets.length}/${max_peers}), skipping keep-alive check`);
            setTimeout(() => p2p.keepAlive(), keep_alive_interval);
            return;
        }

        const currentTime = Date.now();

        // Clean up old connection attempts (older than 5 minutes)
        for (const peer in p2p.recentConnectionAttempts) {
            const retryInfo = p2p.recentConnectionAttempts[peer];
            if (retryInfo && currentTime - retryInfo.lastAttempt > 300000) {  // 5 minutes
                delete p2p.recentConnectionAttempts[peer];
            }
        }

        let peers = process.env.PEERS ? process.env.PEERS.split(',') : [];
        let toConnect: string[] = [];

        logger.debug(`[P2P:keepAlive] Processing PEERS list: ${JSON.stringify(peers)}. Sockets: ${p2p.sockets.length}`);

        const maxAttemptsPerCycle = 2;

        for (const peer of peers) {
            if (toConnect.length >= maxAttemptsPerCycle) break;

            const retryInfo = p2p.recentConnectionAttempts[peer];
            if (retryInfo && currentTime - retryInfo.lastAttempt < 60000) { // skip if last attempt < 1 min ago
                logger.debug(`Skipping recent connection attempt to ${peer}`);
                continue;
            }

            let connected = false;
            const urlWithoutProtocol = peer.replace(/^ws:\/\//, '');
            const colonSplit = urlWithoutProtocol.split(':');
            // Ignore the port in peer string since your nodes always use 6001
            // Just parse IP portion
            let address = colonSplit.slice(0, colonSplit.length - 1).join(':').replace(/^\[|\]$/g, '');

            if (!net.isIP(address)) {
                try {
                    address = (await dns.promises.lookup(address)).address;
                } catch (e) {
                    let errorMessage = '';
                    if (e instanceof Error) {
                        errorMessage = e.message;
                    } else {
                        errorMessage = String(e);
                    }
                    logger.debug(`DNS lookup failed for ${address}: ${errorMessage}`);
                    p2p.recentConnectionAttempts[peer] = { attempts: 1, lastAttempt: currentTime };
                    continue;
                }
            }

            for (const sock of p2p.sockets) {
                if (!sock._socket) continue;
                let remoteAddress = sock._socket.remoteAddress || '';
                if (remoteAddress.startsWith('::ffff:')) {
                    remoteAddress = remoteAddress.slice(7);
                }
                // ONLY compare IP, ignoring remotePort because ephemeral ports change
                if (remoteAddress === address) {
                    connected = true;
                    break;
                }
            }

            if (!connected) {
                toConnect.push(peer);
                if (retryInfo) {
                    p2p.recentConnectionAttempts[peer] = { attempts: retryInfo.attempts + 1, lastAttempt: currentTime };
                } else {
                    p2p.recentConnectionAttempts[peer] = { attempts: 1, lastAttempt: currentTime };
                }
            }
        }

        if (toConnect.length > 0) {
            logger.debug(`[P2P:keepAlive] Attempting to connect to ${toConnect.length} peer(s) from PEERS list: ${JSON.stringify(toConnect)}`);
            p2p.connect(toConnect);
        }

        setTimeout(() => p2p.keepAlive(), keep_alive_interval);
    },

    connect: (urls: string[], isInit: boolean = false) => {
        logger.debug(`[P2P:connect] Called with URLs: ${JSON.stringify(urls)}, isInit: ${isInit}. Current sockets: ${p2p.sockets.length}`);
        for (const url of urls) {
            const normalizedFullUrl = normalizeWsUrl(url); // Normalize the full URL including ws://
            logger.debug(`[P2P:connect] Attempting connection to: ${normalizedFullUrl}`);

            if (p2p.isConnectedTo(normalizedFullUrl)) {
                logger.debug(`[P2P:connect] Already connected to ${normalizedFullUrl}, skipping.`);
                continue;
            }
            try {
                // Remove 'ws://' or 'wss://' prefix first
                const urlWithoutProtocol = url.replace(/^(ws:\/\/|wss:\/\/)/i, '');
    
                // Find the last colon to correctly separate host and port
                const lastColonIndex = urlWithoutProtocol.lastIndexOf(':');
                // We will ignore the port from the URL and always use the configured p2p_port
                // But we still need to extract the host correctly.
                let host = urlWithoutProtocol;
                if (lastColonIndex !== -1) {
                    host = urlWithoutProtocol.substring(0, lastColonIndex);
                }
    
                // Strip IPv4-mapped IPv6 prefix if present from the host
                if (host.startsWith('::ffff:')) {
                    host = host.slice(7);
                }
                // Remove potential brackets if IPv6 address was already wrapped
                if (host.startsWith('[') && host.endsWith(']')) {
                    host = host.slice(1, -1);
                }

                // ALWAYS use the defined p2p_port, ignore port from peer list URL
                const portToUse = p2p_port;

                // Prevent connecting to self via known local/configured addresses
                const selfHostsToAvoid = ['127.0.0.1', 'localhost', '::1'];
                const primaryLocalIP = ip.address(); // Gets primary local IP, e.g., 192.168.x.x
                if (primaryLocalIP) {
                    selfHostsToAvoid.push(primaryLocalIP);
                }

                // If P2P_HOST is a specific IP we are listening on, add it.
                if (p2p_host && p2p_host !== '0.0.0.0' && p2p_host !== '::' && net.isIP(p2p_host)) {
                    selfHostsToAvoid.push(p2p_host);
                }

                // Check if the target host (after normalization) is one of our known self hosts.
                if (selfHostsToAvoid.includes(host) && portToUse === p2p_port) {
                    logger.debug(`[P2P:connect] Skipping connection to self (target host '${host}' is a known self IP/loopback): ${url}`);
                    continue;
                }

                // Additionally, if P2P_HOST is a specific hostname we are listening on,
                // and the target 'host' string exactly matches this configured P2P_HOST hostname.
                if (p2p_host && p2p_host !== '0.0.0.0' && p2p_host !== '::' && !net.isIP(p2p_host) && host === p2p_host && portToUse === p2p_port) {
                    logger.debug(`[P2P:connect] Skipping connection to self (target host '${host}' matches configured P2P_HOST hostname): ${url}`);
                    continue;
                }
    
                // Construct proper ws URL. Ensure IPv6 literals are bracketed for WebSocket constructor.
                const wsHost = net.isIPv6(host) ? `[${host}]` : host;
                const wsUrl = `ws://${wsHost}:${portToUse}`;

                // Update normalizedFullUrl to reflect the URL we are actually going to use (with the correct port)
                // This is important for the isConnectedTo check.
                const effectiveNormalizedUrl = wsUrl; 
    
                // Check if already connected to the effective URL (IP + standard port)
                if (p2p.isConnectedTo(effectiveNormalizedUrl)) {
                    logger.debug(`[P2P:connect] Already connected to ${effectiveNormalizedUrl} (using standard port), skipping.`);
                    continue;
                }

                logger.debug(`[P2P:connect] Attempting connection to: ${url} (resolved to ${wsUrl})`);
    
                const ws = new WebSocket(wsUrl) as EnhancedWebSocket;
                (ws as EnhancedWebSocket)._peerUrl = wsUrl; // Store the effectively used URL
    
                ws.on('open', () => {
                    logger.debug(`[P2P:connect] Successfully opened WebSocket connection to ${wsUrl}. Initiating handshake.`);
                    p2p.handshake(ws);
                });
    
                ws.on('error', (err) => {
                    logger.warn(`[P2P:connect] Failed to connect to ${url} (normalized: ${wsUrl}): ${err.message}`);
                    p2p.pendingConnections.delete(normalizedFullUrl);
                });
    
                ws.on('close', (code, reason) => {
                    logger.debug(`[P2P:connect] Connection closed to ${url} (normalized: ${wsUrl}). Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
                    p2p.pendingConnections.delete(normalizedFullUrl);
                    // p2p.sockets = p2p.sockets.filter(s => s !== ws); // This is handled in closeConnection
                });

                p2p.pendingConnections.add(normalizedFullUrl); // Add to pending before handshake completes

            } catch (err: any) {
                logger.warn(`[P2P:connect] Invalid peer URL or port for ${url}: ${err.message}`);
                p2p.pendingConnections.delete(normalizedFullUrl);
            }
        }
    },

    handshake: (ws: EnhancedWebSocket): void => {
        const remoteAddr = ws._socket?.remoteAddress?.replace('::ffff:', '') || 'unknown_incoming_ip';
        const remotePort = ws._socket?.remotePort;
        const localAddr = ws._socket?.localAddress?.replace('::ffff:', '') || 'unknown_local_ip';
        const localPort = ws._socket?.localPort;
        const connectionType = ws._peerUrl ? 'Outgoing' : 'Incoming';
        const peerIdentifier = ws._peerUrl || `${remoteAddr}:${remotePort}`;

        logger.debug(`[P2P:handshake] ${connectionType} connection. Peer: ${peerIdentifier}. Local: ${localAddr}:${localPort}. Remote: ${remoteAddr}:${remotePort}. Current sockets: ${p2p.sockets.length}`);

        if (process.env.OFFLINE) {
            logger.warn('[P2P:handshake] Incoming handshake refused because OFFLINE');
            ws.close();
            return;
        }
    
        if (p2p.sockets.length >= max_peers) {
            logger.warn('Incoming handshake refused because already peered enough ' + p2p.sockets.length + '/' + max_peers);
            ws.close();
            return;
        }
    
        // Check if the peer is already connected
        for (let i = 0; i < p2p.sockets.length; i++) {
            const existingSocket = p2p.sockets[i];
            const existingPeerUrl = (existingSocket as EnhancedWebSocket)._peerUrl || `ws://${existingSocket._socket.remoteAddress}:${existingSocket._socket.remotePort}`;
            const incomingPeerUrl = `ws://${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
    
            if (existingPeerUrl === incomingPeerUrl) {
                logger.debug(`Peer ${incomingPeerUrl} already connected. Closing duplicate.`);
                ws.close();
                return;
            }
        }
    
        logger.debug('Handshaking new peer', ws.url || ws._socket.remoteAddress + ':' + ws._socket.remotePort);
        let random = randomBytes(config.read(0).randomBytesLength).toString('hex');
        ws.challengeHash = random;
    
        ws.pendingDisconnect = setTimeout(() => {
            for (let i = 0; i < p2p.sockets.length; i++) {
                if (p2p.sockets[i].challengeHash === random) {
                    p2p.sockets[i].close();
                    logger.warn('A peer did not reply to NODE_STATUS');
                    continue;
                }
            }
        }, 1000);
    
        p2p.sockets.push(ws);
        p2p.messageHandler(ws);
        p2p.errorHandler(ws);
    
        // Send initial node status query
        p2p.sendJSON(ws, {
            t: MessageType.QUERY_NODE_STATUS,
            d: {
                nodeId: p2p.nodeId?.pub,
                random: random
            }
        });
    
        // After a short delay, query their peer list to discover more peers
        // Schedule initial peer query with a small delay + jitter
        const initialPeerQueryDelay = 3000 + Math.floor(Math.random() * 2000); // 3-5 seconds
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) { // Check if socket is still open
                p2p.sendJSON(ws, {
                    t: MessageType.QUERY_PEER_LIST,
                    d: {}
                });
            }

            // Setup recurring peer list query with jitter
            if (ws.readyState === WebSocket.OPEN) { // Check again before setting interval
                ws.peerQueryIntervalId = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        p2p.sendJSON(ws, {
                            t: MessageType.QUERY_PEER_LIST,
                            d: {}
                        });
                    } else {
                        // If socket is not open, clear interval
                        if (ws.peerQueryIntervalId) {
                            clearInterval(ws.peerQueryIntervalId);
                            ws.peerQueryIntervalId = undefined;
                        }
                    }
                }, PEER_QUERY_BASE_INTERVAL + (Math.random() * PEER_QUERY_JITTER * 2) - PEER_QUERY_JITTER);
            }
        }, initialPeerQueryDelay);
    },

    broadcastSyncStatus: (syncStatus: number | SteemSyncStatus): void => {
        // Broadcast steem sync status to all connected peers
        if (p2p.recovering) return;

        // If syncStatus is a number, it's just the behindBlocks count
        const status: SteemSyncStatus = typeof syncStatus === 'number' ? {
            nodeId: p2p.nodeId?.pub || '',
            behindBlocks: syncStatus,
            isSyncing: steem.getSyncStatus().isSyncing ? steem.isInSyncMode() : (syncStatus > 0),
            timestamp: Date.now()
        } : {
            nodeId: p2p.nodeId?.pub || '',
            behindBlocks: syncStatus.behindBlocks,
            isSyncing: syncStatus.isSyncing,
            timestamp: Date.now(),
            steemBlock: syncStatus.steemBlock,
            blockId: syncStatus.blockId,
            consensusBlocks: syncStatus.consensusBlocks,
            isInWarmup: syncStatus.isInWarmup
        };

        p2p.broadcast({
            t: MessageType.STEEM_SYNC_STATUS,
            d: status
        });

        logger.debug(`Broadcasting sync status: ${status.behindBlocks} blocks behind, Steem block: ${status.steemBlock || 'N/A'}, isSyncing: ${status.isSyncing}, blockId: ${status.blockId || 'N/A'}`);
    },

    messageHandler: (ws: EnhancedWebSocket): void => {
        ws.on('message', async (data: WebSocket.Data) => {
            let message: { t: number, d: any, s?: any };
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                logger.warn('P2P received non-JSON, doing nothing ;)');
                ws.close(1003, "Invalid JSON");
                return;
            }

            if (!message || typeof message.t === 'undefined') return;
            if (!message.d) return;
            // logger.debug('P2P-IN '+message.t)



            switch (message.t) {
                case MessageType.QUERY_NODE_STATUS:
                    // a peer is requesting our node status
                    if (typeof message.d !== 'object'
                        || typeof message.d.nodeId !== 'string'
                        || typeof message.d.random !== 'string')
                        return;

                    let wsNodeId = message.d.nodeId;
                    if (wsNodeId === p2p.nodeId?.pub) {
                        logger.warn('Peer disconnected: same P2P ID');
                        ws.close();
                        return;
                    }

                    const wsIndex = p2p.sockets.indexOf(ws);
                    if (wsIndex > -1) {
                        p2p.sockets[wsIndex].node_status = {
                            nodeId: message.d.nodeId,
                            head_block: 0,
                            head_block_hash: '',
                            previous_block_hash: '',
                            origin_block: '',
                            version: ''
                        };
                    }

                    // Using bs58 from the global import
                    const signature = secp256k1.ecdsaSign(Buffer.from(message.d.random, 'hex'), bs58.decode(p2p.nodeId?.priv || ''));
                    const signatureStr = bs58.encode(signature.signature);

                    let d: NodeStatus & { random: string } = {
                        origin_block: config.read(0).originHash,
                        head_block: chain.getLatestBlock()._id,
                        head_block_hash: chain.getLatestBlock().hash,
                        previous_block_hash: chain.getLatestBlock().phash,
                        nodeId: p2p.nodeId?.pub || '',
                        version: version,
                        sign: signatureStr,
                        random: message.d.random
                    };

                    p2p.sendJSON(ws, { t: MessageType.NODE_STATUS, d: d });
                    break;

                case MessageType.NODE_STATUS:
                    if (typeof message.d.sign === 'string') {
                        const nodeStatusIndex = p2p.sockets.indexOf(ws);
                        if (nodeStatusIndex === -1) return;

                        const socket = p2p.sockets[nodeStatusIndex];
                        if (!socket.node_status) {
                            logger.warn('No node_status present, disconnecting');
                            ws.close();
                            return;
                        }

                        const nodeId = socket.node_status.nodeId;
                        if (!message.d.nodeId || message.d.nodeId !== nodeId) return;

                        if (!nodeId) {
                            logger.warn('NODE_STATUS with missing nodeId, disconnecting');
                            ws.close();
                            return;
                        }

                        const challengeHash = socket.challengeHash;
                        if (!challengeHash) return;

                        if (message.d.origin_block !== config.read(0).originHash) {
                            logger.debug('Different chain id, disconnecting');
                            ws.close();
                            return;
                        }

                        try {
                            const isValidSignature = secp256k1.ecdsaVerify(
                                bs58.decode(message.d.sign),
                                Buffer.from(challengeHash, 'hex'),
                                bs58.decode(nodeId)
                            );

                            if (!isValidSignature) {
                                logger.warn('Wrong NODE_STATUS signature, disconnecting');
                                ws.close();
                                return;
                            }

                            for (let i = 0; i < p2p.sockets.length; i++) {
                                if (i !== nodeStatusIndex
                                    && p2p.sockets[i].node_status
                                    && p2p.sockets[i].node_status?.nodeId === nodeId) {
                                    logger.debug('Peer disconnected because duplicate connections');
                                    p2p.sockets[i].close();
                                }
                            }

                            if (socket.pendingDisconnect) {
                                clearTimeout(socket.pendingDisconnect);
                            }

                            delete message.d.sign;
                            socket.node_status = message.d;
                        } catch (error) {
                            logger.error('Error during NODE_STATUS verification', error);
                        }
                    }
                    break;

                case MessageType.QUERY_BLOCK:
                    // a peer wants to see the data in one of our stored blocks
                    if ((blocks as any).isOpen) {
                        let block = {};
                        try {
                            block = (blocks as any).read(message.d);
                        } catch (e) {
                            break;
                        }
                        logger.debug(`[P2P] Sending block #${(block as Block)._id} with ${(block as Block).txs?.length ?? 0} txs (memory)`);
                        p2p.sendJSON(ws, { t: MessageType.BLOCK, d: block });
                    } else {
                        const start = Date.now();
                        try {
                            const block = await mongo.getDb().collection('blocks').findOne({ _id: message.d });
                            logger.debug(`[P2P] Sending block #${block?._id} with ${block?.txs?.length ?? 0} txs (db)`);
                            logger.debug(`[P2P] findOne for block ${message.d} took ${Date.now() - start}ms`);
                            if (block) {
                                p2p.sendJSON(ws, { t: MessageType.BLOCK, d: block });
                            }
                        } catch (err) {
                            logger.error(`[P2P] MongoDB error for block ${message.d}: ${err}`);
                        }

                    }
                    break;

                case MessageType.BLOCK:
                    // a peer sends us a block we requested with QUERY_BLOCK
                    logger.info(`[P2P] Received block #${message.d?._id} with ${message.d?.txs?.length ?? 0} txs`);
                    if (!message.d._id || !p2p.recoveringBlocks.includes(message.d._id)) return;
                    for (let i = 0; i < p2p.recoveringBlocks.length; i++)
                        if (p2p.recoveringBlocks[i] === message.d._id) {
                            p2p.recoveringBlocks.splice(i, 1);
                            break;
                        }

                    if (chain.getLatestBlock()._id + 1 === message.d._id) {
                        p2p.addRecursive(message.d);
                    } else {
                        p2p.recoveredBlocks[message.d._id] = message.d;
                        p2p.recover();
                    }
                    if (message.d && message.d._id) {
                        pendingBlockRequests.delete(message.d._id);
                        blockRequestRetries.delete(message.d._id); // Clean up retry info on success
                    }
                    break;

                case MessageType.NEW_BLOCK:

                    // we received a new block we didn't request from a peer
                    // we save the head_block of our peers
                    // and we forward the message to consensus if we are not replaying
                    if (!message.d) return;
                    let block = message.d;

                    const newBlockIndex = p2p.sockets.indexOf(ws);
                    if (newBlockIndex === -1) return;

                    let socket = p2p.sockets[newBlockIndex];
                    if (!socket || !socket.node_status) return;
                    if (socket.node_status.head_block) {
                        socket.node_status.head_block = block._id;
                        socket.node_status.head_block_hash = block.hash;
                        socket.node_status.previous_block_hash = block.phash;
                    }

                    if (p2p.recovering) return;
                    consensus.round(0, block);
                    break;

                case MessageType.BLOCK_CONF_ROUND:
                    // we are receiving a consensus round confirmation
                    // it should come from one of the elected leaders, so let's verify signature
                    if (p2p.recovering) return;
                    if (!message.s || !message.s.s || !message.s.n) return;
                    if (!message.d || !message.d.ts ||
                        typeof message.d.ts != 'number' ||
                        message.d.ts + 2 * config.read(0).blockTime < new Date().getTime() ||
                        message.d.ts - 2 * config.read(0).blockTime > new Date().getTime()) return;

                    logger.debug(message.s.n + ' U-R' + message.d.r);

                    const wsConfIndex = p2p.sockets.indexOf(ws);
                    if (wsConfIndex > -1) {
                        if (!p2p.sockets[wsConfIndex].sentUs)
                            p2p.sockets[wsConfIndex].sentUs = [];
                        p2p.sockets[wsConfIndex].sentUs.push([message.s.s, new Date().getTime()]);
                    }

                    for (let i = 0; i < consensus.processed.length; i++) {
                        if (consensus.processed[i][1] + 2 * config.read(0).blockTime < new Date().getTime()) {
                            consensus.processed.splice(i, 1);
                            i--;
                            continue;
                        }
                        // Convert to consistent format before comparison
                        if (consensus.processed[i][0].s === message.s.n)
                            return;
                    }

                    verifySignature(message, function (isValid: boolean) {
                        if (!isValid && !p2p.recovering) {
                            logger.warn('Received wrong consensus signature', message);
                            return;
                        }

                        // bounce the message to peers
                        p2p.broadcastNotSent(message);
                        // always try to precommit in case its the first time we see it
                        consensus.round(0, message.d.b, function (validationStep: number) {
                            if (validationStep === -1) {
                                // logger.trace('Ignored BLOCK_CONF_ROUND')
                            } else if (validationStep === 0) {
                                consensus.queue.push(message);
                                logger.debug('Added to queue');
                            } else
                                // process the message inside the consensus
                                consensus.remoteRoundConfirm(message);
                        });
                    });
                    break;

                case MessageType.STEEM_SYNC_STATUS:
                    // Handle sync status information from peers
                    if (!message.d || !message.d.nodeId || typeof message.d.behindBlocks !== 'number') {
                        break;
                    }

                    if (!p2p.recovering) {
                        // Store the sync status for this peer
                        const syncSocketIndex = p2p.sockets.indexOf(ws);
                        if (syncSocketIndex > -1) {
                            p2p.sockets[syncSocketIndex].steemSyncStatus = message.d;
                        }

                        steem.receivePeerSyncStatus(message.d.nodeId, {
                            nodeId: message.d.nodeId,
                            behindBlocks: message.d.behindBlocks,
                            isSyncing: message.d.isSyncing,
                            steemBlock: message.d.steemBlock,
                            blockId: message.d.blockId,
                            consensusBlocks: message.d.consensusBlocks,
                            exitTarget: message.d.exitTarget,
                            timestamp: message.d.timestamp
                        });

                        logger.debug(`Received sync status from ${message.d.nodeId}: ${message.d.behindBlocks} blocks behind, isSyncing: ${message.d.isSyncing}`);
                    }
                    break;
                // On receiving QUERY_PEER_LIST:
                case MessageType.QUERY_PEER_LIST:
                    // Send list of peer ws URLs (from existing sockets)
                    const knownPeers = p2p.sockets
                        .map(s => s.url || `ws://${s._socket.remoteAddress}:${s._socket.remotePort}`)
                        .filter(Boolean); // just in case

                    p2p.sendJSON(ws, { t: MessageType.PEER_LIST, d: { peers: knownPeers } });
                    break;

                // On receiving PEER_LIST:
                case MessageType.PEER_LIST:
                    if (!message.d || !Array.isArray(message.d.peers)) {
                        logger.warn(`[P2P:messageHandler] ${ws._peerUrl || (ws._socket ? `${ws._socket.remoteAddress?.replace('::ffff:', '')}:${ws._socket.remotePort}` : 'unknown_peer')}: Invalid PEER_LIST message structure`);
                        return;
                    }
                    const receivedPeers: string[] = message.d.peers;
                    logger.debug(`[P2P:messageHandler] ${ws._peerUrl || (ws._socket ? `${ws._socket.remoteAddress?.replace('::ffff:', '')}:${ws._socket.remotePort}` : 'unknown_peer')}: Received PEER_LIST with ${receivedPeers.length} peers.`);

                    const selfP2PPort = p2p_port; // The port this node listens on
                    const selfIPs = [ip.address(), '127.0.0.1', '::1', 'localhost']; // Common local addresses
                    if (p2p_host !== '::' && p2p_host !== '0.0.0.0') {
                        selfIPs.push(p2p_host); // Add specific listen host if configured
                    }

                    const peersToConnect = receivedPeers.filter(peerUrl => {
                        try {
                            const normalizedPeerUrl = normalizeWsUrl(peerUrl); // Normalize before parsing
                            const url = new URL(normalizedPeerUrl);
                            const peerHost = url.hostname;
                            const peerPort = parseInt(url.port, 10);

                            // Check if it's one of the known self IPs and the same P2P port
                            if (selfIPs.some(selfIp => selfIp === peerHost) && peerPort === selfP2PPort) {
                                logger.debug(`[P2P:messageHandler] Filtering out self from received peer list: ${peerUrl} (normalized: ${normalizedPeerUrl})`);
                                return false;
                            }
                            return true;
                        } catch (e: any) {
                            logger.warn(`[P2P:messageHandler] Invalid peer URL in PEER_LIST: ${peerUrl} (normalization attempt failed or URL still invalid after norm)`);
                            return false;
                        }
                    });

                    if (peersToConnect.length > 0) {
                        logger.debug(`[P2P:messageHandler] Attempting to connect to ${peersToConnect.length} new peers from list.`);
                        p2p.connect(peersToConnect, false);
                    }
                    return;
            }
        });
    },

    recover: (): void => {
        if (!p2p.sockets || p2p.sockets.length === 0) return;
        if (Object.keys(p2p.recoveredBlocks).length + p2p.recoveringBlocks.length > max_blocks_buffer) return;
        if (!p2p.recovering) p2p.recovering = chain.getLatestBlock()._id;
        const latestBlockId = chain.getLatestBlock()._id;
        let peersAhead: EnhancedWebSocket[] = [];
        for (let i = 0; i < p2p.sockets.length; i++) {
            const ns = p2p.sockets[i].node_status;
            if (
                ns &&
                ns.head_block !== undefined && ns.head_block > latestBlockId &&
                ns.origin_block === config.read(0).originHash
            ) {
                peersAhead.push(p2p.sockets[i]);
            }
        }
        if (peersAhead.length === 0) {
            logger.debug(`No peers ahead. My head: ${latestBlockId}, peers: ${p2p.sockets.map(s => s.node_status?.head_block).join(', ')}`);
            p2p.recovering = false;
            return;
        }
        const nextBlockToRecover = (p2p.recovering as number) + 1;
        if (nextBlockToRecover <= latestBlockId) {
            logger.warn(`Attempted to recover block ${nextBlockToRecover} that is not ahead of our chain. Resetting recovery.`);
            p2p.recovering = latestBlockId;
            return;
        }
        let retryInfo = blockRequestRetries.get(nextBlockToRecover);
        if (!retryInfo) {
            retryInfo = { attempts: 0, triedPeers: new Set() };
            blockRequestRetries.set(nextBlockToRecover, retryInfo);
        }
        const availablePeers = peersAhead.filter(
            peer => peer.node_status?.nodeId && !retryInfo!.triedPeers.has(peer.node_status.nodeId)
        );
        let peerToTry: EnhancedWebSocket | undefined = availablePeers.length > 0
            ? availablePeers[Math.floor(Math.random() * availablePeers.length)]
            : undefined;
        if (!peerToTry) {
            retryInfo.attempts++;
            retryInfo.triedPeers.clear();
            if (retryInfo.attempts > MAX_BLOCK_RETRIES) {
                logger.error(`Failed to recover block ${nextBlockToRecover} after ${MAX_BLOCK_RETRIES} attempts. Skipping.`);
                blockRequestRetries.delete(nextBlockToRecover);
                pendingBlockRequests.delete(nextBlockToRecover);
                p2p.recovering = false;
                return;
            }
            peerToTry = peersAhead[Math.floor(Math.random() * peersAhead.length)];
        }
        if (!pendingBlockRequests.has(nextBlockToRecover)) {
            pendingBlockRequests.add(nextBlockToRecover);
            retryInfo!.triedPeers.add(peerToTry.node_status?.nodeId || '');
            logger.debug(`Requesting block ${nextBlockToRecover} from peer ${peerToTry.node_status?.nodeId}, attempt ${retryInfo.attempts + 1}`);
            (p2p.recovering as number)++;
            p2p.sendJSON(peerToTry, { t: MessageType.QUERY_BLOCK, d: p2p.recovering });
            if (!p2p.recoveringBlocks.includes(p2p.recovering as number))
                p2p.recoveringBlocks.push(p2p.recovering as number);
            setTimeout(() => {
                pendingBlockRequests.delete(nextBlockToRecover);
                // Immediately retry if still behind
                if (p2p.recovering && p2p.recovering >= latestBlockId) {
                    p2p.recover();
                }
            }, 10000);
        } else {
            logger.debug(`Block ${nextBlockToRecover} request already pending, not resending.`);
        }
    },

    refresh: (force: boolean = false): void => {

        // Don't start a new recovery if one is already in progress
        if (p2p.recovering && !force) {
            return;
        }
        // else if(refreshAttempt >= max_refresh_attempts) {
        //     refreshAttempt = 0;
        //     p2p.recovering = false;
        //     p2p.recoveringBlocks = []; // Clear any blocks being recovered
        //     p2p.recoveredBlocks = {}; // Clear any previously recovered blocks
        //     p2p.refresh(true);
        // }
        // Get latest block from our chain
        const latestBlockId = chain.getLatestBlock()._id;

        // Require at least one connected peer
        if (!p2p.sockets || p2p.sockets.length === 0) {
            logger.debug('No peers connected, skipping refresh');
            return;
        }

        // Find peers that are significantly ahead of us (at least 10 blocks)
        let peersAhead: EnhancedWebSocket[] = [];
        for (let i = 0; i < p2p.sockets.length; i++) {
            const ns = p2p.sockets[i].node_status;
            if (
                ns &&
                ns.head_block !== undefined && ns.head_block > latestBlockId + 10 &&
                ns.origin_block === config.read(0).originHash
            ) {
                peersAhead.push(p2p.sockets[i]);
            }
        }

        if (peersAhead.length === 0) {
            logger.debug('No peers significantly ahead of us (10+ blocks), skipping refresh');
            return;
        }

        // Start recovery from our current block
        logger.info(`Catching up with network, our head block: ${latestBlockId}, highest peer block: ${Math.max(...peersAhead.map(p => p.node_status?.head_block || 0))}`);
        p2p.recovering = latestBlockId;
        p2p.recoverAttempt = 0; // Reset recovery attempts when starting a new recovery
        p2p.recoveredBlocks = {}; // Clear any previously recovered blocks
        p2p.recoveringBlocks = []; // Clear any blocks being recovered
        p2p.recover();
    },

    errorHandler: (ws: EnhancedWebSocket): void => {
        ws.on('close', () => p2p.closeConnection(ws));
        ws.on('error', () => p2p.closeConnection(ws));
    },

    closeConnection: (ws: EnhancedWebSocket): void => {
        const peerIdentifier = ws.node_status?.nodeId || ws._peerUrl || (ws._socket ? `${ws._socket.remoteAddress?.replace('::ffff:', '')}:${ws._socket.remotePort}` : 'unknown_peer');
        const index = p2p.sockets.indexOf(ws);
        if (index > -1) {
            p2p.sockets.splice(index, 1);
            logger.debug(`[P2P:closeConnection] Peer ${peerIdentifier} disconnected. Sockets remaining: ${p2p.sockets.length}`);
        } else {
            logger.warn(`[P2P:closeConnection] Attempted to close connection for a peer not in sockets list: ${peerIdentifier}`);
        }
        // Remove from pending if it was there
        if (ws._peerUrl) {
            p2p.pendingConnections.delete(ws._peerUrl);
        }
        // Clear the recurring peer query interval if it exists
        if (ws.peerQueryIntervalId) {
            clearInterval(ws.peerQueryIntervalId);
            ws.peerQueryIntervalId = undefined;
            logger.debug(`[P2P:closeConnection] Cleared peer query interval for ${peerIdentifier}`);
        }
    },

    sendJSON: (ws: EnhancedWebSocket, d: { t: number, d: any, s?: any }): void => {
        const peerIdentifier = ws.node_status?.nodeId || ws._peerUrl || (ws._socket ? `${ws._socket.remoteAddress?.replace('::ffff:', '')}:${ws._socket.remotePort}` : 'unknown_peer');
        try {
            let data = JSON.stringify(d);
            // logger.debug('P2P-OUT:', d.t)
            ws.send(data);
        } catch (error: any) {
            logger.warn(`[P2P:sendJSON] Failed to send message type ${d.t} to peer ${peerIdentifier}: ${error.message}`);
        }
    },

    broadcastNotSent: (d: any): void => {
        logger.debug(`[P2P:broadcastNotSent] Broadcasting message type ${d.t} to eligible peers. Current sockets: ${p2p.sockets.length}`);
        firstLoop:
        for (let i = 0; i < p2p.sockets.length; i++) {
            if (!p2p.sockets[i].sentUs) {
                p2p.sendJSON(p2p.sockets[i], d);
                continue;
            }
            const sentUs = p2p.sockets[i].sentUs;
            if (sentUs) {
                for (let y = 0; y < sentUs.length; y++)
                    if (sentUs[y][0] === d.s.s)
                        continue firstLoop;
            }
            p2p.sendJSON(p2p.sockets[i], d);
        }
    },

    broadcast: (d: any): void => {
        logger.debug(`[P2P:broadcast] Broadcasting message type ${d.t} to ALL ${p2p.sockets.length} peers.`);
        p2p.sockets.forEach(ws => p2p.sendJSON(ws, d))
    },

    broadcastBlock: (block: Block): void => {
        logger.debug(`[P2P:broadcastBlock] Broadcasting block #${block._id} with ${block.txs?.length ?? 0} txs to ${p2p.sockets.length} peers.`);
        p2p.broadcast({ t: MessageType.NEW_BLOCK, d: block });
    },

    addRecursive: (block: Block): void => {
        logger.debug(`[P2P] Entering addRecursive for block _id=${block._id}`);
        const latestBlockId = chain.getLatestBlock()._id;

        if (block._id <= latestBlockId) {
            logger.warn(`[P2P] Skipping block ${block._id} in addRecursive as we already have blocks up to ${latestBlockId}`);
            delete p2p.recoveredBlocks[block._id];
            p2p.recover();
            return;
        }

        if (block._id !== latestBlockId + 1) {
            logger.warn(`[P2P] Received block ${block._id} out of sequence (expected ${latestBlockId + 1})`);
            delete p2p.recoveredBlocks[block._id];
            p2p.recovering = latestBlockId;
            p2p.recover();
            return;
        }

        logger.debug(`[P2P] Validating and adding block #${block._id}`);

        chain.validateAndAddBlock(block, true, (err: any | null, newBlock: Block | null) => {
            if (err) {
                logger.error(`[P2P] Failed to validate block ${block._id}: ${err}`);
                cache.rollback();
                logger.warn(`[P2P] Failed to validate block ${block._id}, clearing recovery cache`);
                p2p.recoveredBlocks = {};
                p2p.recoveringBlocks = [];
                p2p.recoverAttempt++;
                if (p2p.recoverAttempt > max_recover_attempts) {
                    logger.error(`[P2P] Error Replay - exceeded maximum recovery attempts for block ${newBlock?._id}`);
                    p2p.recovering = false;
                    p2p.recoverAttempt = 0;
                    return;
                } else {
                    logger.debug(`[P2P] Recover attempt #${p2p.recoverAttempt} for block ${newBlock?._id}`);
                    p2p.recovering = chain.getLatestBlock()._id;
                    p2p.recover();
                }
            } else {
                p2p.recoverAttempt = 0;
                if (newBlock) {
                    delete p2p.recoveredBlocks[newBlock._id];
                }
                p2p.recover();
                // If next block is in cache, process it recursively
                if (p2p.recoveredBlocks[chain.getLatestBlock()._id + 1])
                    setTimeout(function () {
                        if (p2p.recoveredBlocks[chain.getLatestBlock()._id + 1])
                            p2p.addRecursive(p2p.recoveredBlocks[chain.getLatestBlock()._id + 1])
                    }, 1)
            }
        });
    },

    cleanRoundConfHistory: (): void => {
        logger.debug('Cleaning old p2p messages history');
        for (let i = 0; i < p2p.sockets.length; i++) {
            const sentUs = p2p.sockets[i].sentUs;
            if (sentUs) {
                for (let y = 0; y < sentUs.length; y++)
                    if (new Date().getTime() - sentUs[y][1] > keep_history_for) {
                        sentUs.splice(y, 1);
                        y--;
                    }
            }
        }
    }
};


export default p2p; 