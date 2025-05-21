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

const RETRY_BASE_DELAY = 30 * 1000; // 30 seconds base delay
const RETRY_MAX_DELAY = 15 * 60 * 1000; // Max 15 minutes

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

    discoveryWorker: (isInit: boolean = false): void => {
        const configBlock = config.read(0);
        const maxPeers = max_peers;

        // Generate witnesses, assuming generateWitnesses returns array of { name: string, ws: string | undefined }
        let witnesses = witnessesModule.generateWitnesses(false, true, configBlock.witnesses * 3, 0);
        if (!Array.isArray(witnesses) || witnesses.length === 0) {
            logger.warn('No witnesses found for discovery.');
            return;
        }

        for (const witness of witnesses) {
            if (p2p.sockets.length >= maxPeers) {
                logger.debug(`Max peers reached: ${p2p.sockets.length}/${maxPeers}`);
                break;
            }

            if (!witness.ws) continue;

            const excluded = process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : [];
            if (excluded.includes(witness.name)) continue;

            let isConnected = false;

            for (const socket of p2p.sockets) {
                let ip = socket._socket.remoteAddress || '';
                if (ip.startsWith('::ffff:')) ip = ip.slice(7);

                try {
                    const witnessIp = new URL(witness.ws).hostname;
                    if (witnessIp === ip) {
                        logger.warn(`Already connected to witness ${witness.name} (${witness.ws})`);
                        isConnected = true;
                        break;
                    }
                } catch (e) {
                    logger.debug(`Invalid witness ws url: ${witness.ws} for witness ${witness.name}`, e);
                }
            }

            if (!isConnected) {
                logger[isInit ? 'info' : 'debug'](`Connecting to witness ${witness.name} at ${witness.ws}`);
                p2p.connect([witness.ws], isInit);
            }
        }
    },

    keepAlive: async (): Promise<void> => {
        if (p2p.sockets.length >= max_peers) {
            logger.debug(`Already at max peers (${p2p.sockets.length}/${max_peers}), skipping keep-alive check`);
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
            const port = parseInt(colonSplit.pop() || '0', 10);
            let address = colonSplit.join(':').replace(/^\[|\]$/g, ''); // strip brackets for IPv6

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
                    // Record failed attempt with lastAttempt timestamp and reset attempts to 1
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
                if (remoteAddress === address && sock._socket.remotePort === port) {
                    connected = true;
                    break;
                }
            }

            if (!connected) {
                toConnect.push(peer);
                // Record this connection attempt or update attempt count if exists
                if (retryInfo) {
                    p2p.recentConnectionAttempts[peer] = { attempts: retryInfo.attempts + 1, lastAttempt: currentTime };
                } else {
                    p2p.recentConnectionAttempts[peer] = { attempts: 1, lastAttempt: currentTime };
                }
            }
        }

        if (toConnect.length > 0) {
            logger.debug(`Keep-alive: attempting to connect to ${toConnect.length} peer(s)`);
            p2p.connect(toConnect);
        }

        setTimeout(() => p2p.keepAlive(), keep_alive_interval);
    },

    connect: function (urls: string[], isInit: boolean = false) {
        for (const url of urls) {
            if (this.isConnectedTo(url) || this.pendingConnections.has(url)) {
                logger.debug(`Already connected or connecting to ${url}, skipping`);
                continue;
            }

            const retryInfo = this.recentConnectionAttempts[url];
            const now = Date.now();

            if (retryInfo) {
                // Calculate backoff delay: exponential based on attempts
                const delay = Math.min(RETRY_BASE_DELAY * (2 ** (retryInfo.attempts - 1)), RETRY_MAX_DELAY);

                if (now - retryInfo.lastAttempt < delay) {
                    logger.debug(`Backoff active for ${url}, skipping connect`);
                    continue;
                }
            }

            try {
                this.pendingConnections.add(url);
                this.recentConnectionAttempts[url] = {
                    attempts: (retryInfo?.attempts || 0) + 1,
                    lastAttempt: now,
                };

                const ws = new WebSocket(url) as EnhancedWebSocket;
                (ws as any)._peerUrl = url;

                ws.on('open', () => {
                    logger.info(`Connected to peer ${url}`);
                    this.pendingConnections.delete(url);
                    // Reset attempts on success
                    if (this.recentConnectionAttempts[url]) {
                        this.recentConnectionAttempts[url].attempts = 0;
                    }
                    this.handshake(ws);
                });

                ws.on('error', (err) => {
                    logger.debug(`Failed to connect to ${url}: ${err.message}`);
                    this.pendingConnections.delete(url);
                });

                ws.on('close', () => {
                    logger.info(`Connection closed: ${url}`);
                    this.pendingConnections.delete(url);
                    this.sockets = this.sockets.filter(s => s !== ws);
                });

                this.messageHandler(ws);
                this.errorHandler(ws);
            } catch (err) {
                logger.error(`Exception connecting to ${url}: ${err}`);
                this.pendingConnections.delete(url);
            }
        }
    },

    handshake: (ws: EnhancedWebSocket): void => {
        if (process.env.OFFLINE) {
            logger.warn('Incoming handshake refused because OFFLINE');
            ws.close();
            return;
        }

        if (p2p.sockets.length >= max_peers) {
            logger.warn('Incoming handshake refused because already peered enough ' + p2p.sockets.length + '/' + max_peers);
            ws.close();
            return;
        }

        for (let i = 0; i < p2p.sockets.length; i++)
            if (p2p.sockets[i]._socket.remoteAddress === ws._socket.remoteAddress
                && p2p.sockets[i]._socket.remotePort === ws._socket.remotePort) {
                ws.close();
                return;
            }

        logger.debug('Handshaking new peer', ws.url || ws._socket.remoteAddress + ':' + ws._socket.remotePort);
        let random = randomBytes(config.read(0).randomBytesLength).toString('hex');
        ws.challengeHash = random;

        ws.pendingDisconnect = setTimeout(() => {
            for (let i = 0; i < p2p.sockets.length; i++)
                if (p2p.sockets[i].challengeHash === random) {
                    p2p.sockets[i].close();
                    logger.warn('A peer did not reply to NODE_STATUS');
                    continue;
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
        setTimeout(() => {
            p2p.sendJSON(ws, {
                t: MessageType.QUERY_PEER_LIST,
                d: {}
            });
        }, 1500);  // 1.5 seconds delay to avoid flooding
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
                        logger.info(`[P2P] Sending block #${(block as Block)._id} with ${(block as Block).txs?.length ?? 0} txs (memory)`);
                        p2p.sendJSON(ws, { t: MessageType.BLOCK, d: block });
                    } else {
                        const start = Date.now();
                        try {
                            const block = await mongo.getDb().collection('blocks').findOne({ _id: message.d });
                            logger.info(`[P2P] Sending block #${block?._id} with ${block?.txs?.length ?? 0} txs (db)`);
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
                    if (Array.isArray(message.d.peers)) {
                        for (const peerUrl of message.d.peers) {
                            // Skip if already connected
                            if (!p2p.isConnectedTo(peerUrl)) {
                                p2p.connect([peerUrl], false);
                            }
                        }
                    }
                    break;
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
        const index = p2p.sockets.indexOf(ws);
        if (index > -1) {
            p2p.sockets.splice(index, 1);
            logger.debug('a peer disconnected, ' + p2p.sockets.length + ' peers left');
        }
    },

    sendJSON: (ws: EnhancedWebSocket, d: { t: number, d: any, s?: any }): void => {
        try {
            let data = JSON.stringify(d);
            // logger.debug('P2P-OUT:', d.t)
            ws.send(data);
        } catch (error) {
            logger.warn('Tried sending p2p message and failed');
        }
    },

    broadcastNotSent: (d: any): void => {
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

    broadcast: (d: any): void => p2p.sockets.forEach(ws => p2p.sendJSON(ws, d)),

    broadcastBlock: (block: Block): void => {
        logger.info(`[P2P] Broadcasting block #${block._id} with ${block.txs?.length ?? 0} txs`);
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

        logger.info(`[P2P] Validating and adding block #${block._id}`);

        chain.validateAndAddBlock(block, true, (err: any | null, newBlock: Block | null) => {
            if (err) {
                logger.error(`[P2P] Failed to validate block ${block._id}: ${err}`);
                cache.rollback();
                logger.warn(`[P2P] Failed to validate block ${block._id}, clearing recovery cache`);
                p2p.recoveredBlocks = {};
                p2p.recoveringBlocks = [];
                p2p.recoverAttempt++;
                if (p2p.recoverAttempt > max_recover_attempts) {
                    logger.error(`[P2P] Error Replay - exceeded maximum recovery attempts for block ${block._id}`);
                    p2p.recovering = false;
                    p2p.recoverAttempt = 0;
                    return;
                } else {
                    logger.debug(`[P2P] Recover attempt #${p2p.recoverAttempt} for block ${block._id}`);
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
                const nextBlockId = chain.getLatestBlock()._id + 1;
                if (p2p.recoveredBlocks[nextBlockId]) {
                    logger.debug(`[P2P] Found next block ${nextBlockId} in recovery cache, processing immediately`);
                    p2p.addRecursive(p2p.recoveredBlocks[nextBlockId]);
                }
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