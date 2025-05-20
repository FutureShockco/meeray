// TODO: Uncomment and install these dependencies as you migrate the rest of the Echelon codebase
// import config from './config.js';
// import logger from './logger.js';
// import ... (other dependencies)

// TODO: Add proper types for P2P logic, peers, etc.

import WebSocket, { WebSocketServer } from 'ws';
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
import { verifySignature } from './crypto.js';
import mongo from './mongo.js'; // Ensure mongo is imported
// TODO: import steem from './steem.js';
// Dynamically import the 'ws' module
import * as wsModule from 'ws';
const version = '1.6.6';
const default_port = 6001;
const replay_interval = 5000;
const discovery_interval = 30000;
const keep_alive_interval = 10000;
const max_blocks_buffer = 100;
const max_peers = Number(process.env.MAX_PEERS) || 15;
const max_recover_attempts = 25;
const history_interval = 10000;
const keep_history_for = 20000;
const p2p_port = Number(process.env.P2P_PORT) || default_port;
const p2p_host = process.env.P2P_HOST || '::';
const bs58 = baseX(config.b58Alphabet);

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
    challengeHash?: string;
    pendingDisconnect?: NodeJS.Timeout;
    node_status?: NodeStatus;
    sentUs?: [string, number][];
    steemSyncStatus?: SteemSyncStatus;
}

export interface SteemSyncStatus {
    nodeId: string;
    behindBlocks: number;
    isSyncing: boolean;
    timestamp: number;
    steemBlock?: number;
    blockId?: string;
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

export const p2p = {
    sockets: [] as EnhancedWebSocket[],
    recoveringBlocks: [] as number[],
    recoveredBlocks: {} as Record<number, Block>,
    recovering: false as boolean | number,
    recoverAttempt: 0,
    nodeId: null as NodeKeyPair | null,
    recentConnectionAttempts: {} as Record<string, number>,
    refreshAttempt: 0,
    init: async (): Promise<void> => {
        p2p.generateNodeId();

        const WebSocketServer =
            (wsModule as any).WebSocketServer ||
            (wsModule as any).Server ||
            (wsModule.default as any)?.WebSocketServer ||
            (wsModule.default as any)?.Server;


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
        if (!chain) {
            logger.error('Chain module not available for generating node ID');
            return;
        }
        p2p.nodeId = chain.getNewKeyPair();

        logger.info('P2P ID: ' + p2p.nodeId?.pub);
    },

    discoveryWorker: (isInit: boolean = false): void => {
        if (!chain) {
            logger.error('Chain module not available for discovery worker');
            return;
        }

        let witnesses = witnessesModule.generateWitnesses(false, true, config.witnesses * 3, 0);
        for (let i = 0; i < witnesses.length; i++) {
            if (p2p.sockets.length >= max_peers) {
                logger.debug('We already have maximum peers: ' + p2p.sockets.length + '/' + max_peers);
                break;
            }

            if (witnesses[i].ws) {
                let excluded = process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : [];
                if (excluded.indexOf(witnesses[i].name) > -1)
                    continue;

                let isConnected = false;
                for (let w = 0; w < p2p.sockets.length; w++) {
                    let ip = p2p.sockets[w]._socket.remoteAddress;
                    if (ip && ip.indexOf('::ffff:') > -1)
                        ip = ip.replace('::ffff:', '');

                    try {
                        let witnessIp = witnesses[i].ws.split('://')[1].split(':')[0];
                        if (witnessIp === ip) {
                            logger.warn('Already peered with ' + witnesses[i].name);
                            isConnected = true;
                        }
                    } catch (error) {
                        logger.debug('Wrong ws for witness ' + witnesses[i].name + ' ' + witnesses[i].ws, error);
                    }
                }

                if (!isConnected) {
                    logger[isInit ? 'info' : 'debug']('Trying to connect to ' + witnesses[i].name + ' ' + witnesses[i].ws);
                    p2p.connect([witnesses[i].ws], isInit);
                }
            }
        }
    },

    keepAlive: async (): Promise<void> => {
        // Only try to reconnect if we're not at max peers
        if (p2p.sockets.length >= max_peers) {
            logger.debug(`Already at max peers (${p2p.sockets.length}/${max_peers}), skipping keep-alive check`);
            setTimeout(() => p2p.keepAlive(), keep_alive_interval);
            return;
        }
        const currentTime = Date.now();
        // Clean up old connection attempts (older than 5 minutes)
        for (const peer in p2p.recentConnectionAttempts) {
            if (currentTime - p2p.recentConnectionAttempts[peer] > 300000) {
                delete p2p.recentConnectionAttempts[peer];
            }
        }

        // ensure all peers explicitly listed in PEERS are connected when online
        let peers = process.env.PEERS ? process.env.PEERS.split(',') : [];
        let toConnect: string[] = [];

        // Limit the number of connection attempts per keepAlive cycle
        const maxAttemptsPerCycle = 2;

        for (let p = 0; p < peers.length; p++) {
            // Stop if we've reached the maximum attempts for this cycle
            if (toConnect.length >= maxAttemptsPerCycle) break;


            let connected = false;
            let colonSplit = peers[p].replace('ws://', '').split(':');
            let port = parseInt(colonSplit.pop() || '0');
            let address = colonSplit.join(':').replace('[', '').replace(']', '');

            if (!net.isIP(address)) {
                try {
                    address = (await dns.promises.lookup(address)).address;
                } catch (e) {
                    logger.debug('dns lookup failed for ' + address);
                    // Record this failed attempt
                    p2p.recentConnectionAttempts[peers[p]] = currentTime;
                    continue;
                }
            }

            for (let s = 0; s < p2p.sockets.length; s++)
                if (p2p.sockets[s]._socket?.remoteAddress?.replace('::ffff:', '') === address &&
                    p2p.sockets[s]._socket?.remotePort === port) {
                    connected = true;
                    break;
                }

            if (!connected) {
                toConnect.push(peers[p]);
                // Record this connection attempt
                p2p.recentConnectionAttempts[peers[p]] = currentTime;
            }
        }

        if (toConnect.length > 0) {
            logger.debug(`Keep-alive: attempting to connect to ${toConnect.length} peer(s)`);
            p2p.connect(toConnect);
        }

        setTimeout(() => p2p.keepAlive(), keep_alive_interval);
    },

    connect: (newPeers: string[], isInit: boolean = false): void => {
        newPeers.forEach((peer) => {
            const socket = new WebSocket(peer) as EnhancedWebSocket;
            socket.on('open', () => p2p.handshake(socket));
            socket.on('error', () => {
                logger[isInit ? 'warn' : 'debug']('peer connection failed', peer);
            });
        });
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

        // close connection if we already have this peer ip in our connected sockets
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
        p2p.sendJSON(ws, {
            t: MessageType.QUERY_NODE_STATUS,
            d: {
                nodeId: p2p.nodeId?.pub,
                random: random
            }
        });
    },

    broadcastSyncStatus: (syncStatus: any | SteemSyncStatus): void => {
        // Broadcast steem sync status to all connected peers
        if (!steem || p2p.recovering) return;

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

        if (!chain) {
            logger.warn('Chain service unavailable during message processing');
            return;
        }

        if (!consensus) {
            logger.warn('Consensus service unavailable during message processing');
            return;
        }

        ws.on('message', async (data: WebSocket.Data) => {
            let message: { t: number, d: any, s?: any };
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                logger.warn('P2P received non-JSON, doing nothing ;)');
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

                    let d: NodeStatus = {
                        origin_block: config.read(0).originHash,
                        head_block: chain.getLatestBlock()._id,
                        head_block_hash: chain.getLatestBlock().hash,
                        previous_block_hash: chain.getLatestBlock().phash,
                        nodeId: p2p.nodeId?.pub || '',
                        version: version,
                        sign: signatureStr
                    };

                    p2p.sendJSON(ws, { t: MessageType.NODE_STATUS, d: d });
                    break;

                case MessageType.NODE_STATUS:
                    // we received a peer node status
                    if (typeof message.d.sign === 'string') {
                        const nodeStatusIndex = p2p.sockets.indexOf(ws);
                        if (nodeStatusIndex === -1) return;

                        let nodeId = p2p.sockets[nodeStatusIndex].node_status?.nodeId;
                        if (!message.d.nodeId || message.d.nodeId !== nodeId)
                            return;

                        let challengeHash = p2p.sockets[nodeStatusIndex].challengeHash;
                        if (!challengeHash)
                            return;

                        if (message.d.origin_block !== config.read(0).originHash) {
                            logger.debug('Different chain id, disconnecting');
                            ws.close();
                            return;
                        }

                        try {
                            // Using bs58 from the global import
                            let isValidSignature = secp256k1.ecdsaVerify(
                                bs58.decode(message.d.sign),
                                Buffer.from(challengeHash, 'hex'),
                                bs58.decode(nodeId || '')
                            );

                            if (!isValidSignature) {
                                logger.warn('Wrong NODE_STATUS signature, disconnecting');
                                ws.close();
                                return;
                            }

                            for (let i = 0; i < p2p.sockets.length; i++)
                                if (i !== nodeStatusIndex
                                    && p2p.sockets[i]?.node_status
                                    && p2p.sockets[i]?.node_status?.nodeId === nodeId) {
                                    logger.debug('Peer disconnected because duplicate connections');
                                    p2p.sockets[i].close();
                                }

                            if (p2p.sockets[nodeStatusIndex].pendingDisconnect) {
                                clearTimeout(p2p.sockets[nodeStatusIndex].pendingDisconnect);
                            }

                            delete message.d.sign;
                            p2p.sockets[nodeStatusIndex].node_status = message.d;
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
                            const db = mongo.getDb();
                            const block = await db.collection('blocks').findOne({ _id: message.d });
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
                        logger.info(`[P2P][DEBUG] Processing block #${message.d._id} via addRecursive`);
                        p2p.addRecursive(message.d);
                    } else {
                        logger.info(`[P2P][DEBUG] Caching block #${message.d._id} for later processing`);
                        p2p.recoveredBlocks[message.d._id] = message.d;
                        p2p.recover();
                    }
                    if (message.d && message.d._id) {
                        pendingBlockRequests.delete(message.d._id);
                        blockRequestRetries.delete(message.d._id); // Clean up retry info on success
                    }
                    break;

                case MessageType.NEW_BLOCK:
                    logger.info(`[P2P][DEBUG] Is this node observer? ${consensus.observer}`);
                    // we received a new block we didn't request from a peer
                    // we save the head_block of our peers
                    // and we forward the message to consensus if we are not replaying
                    if (!message.d) return;
                    let block = message.d;

                    const newBlockIndex = p2p.sockets.indexOf(ws);
                    if (newBlockIndex === -1) return;

                    let socket = p2p.sockets[newBlockIndex];
                    if (!socket || !socket.node_status) return;

                    if (p2p.sockets && p2p.sockets[newBlockIndex] && p2p.sockets[newBlockIndex].node_status) {
                        p2p.sockets[newBlockIndex].node_status.head_block = block._id;
                        p2p.sockets[newBlockIndex].node_status.head_block_hash = block.hash;
                        p2p.sockets[newBlockIndex].node_status.previous_block_hash = block.phash;
                    }

                    if (p2p.recovering) return;
                    logger.info(`[P2P][DEBUG] Calling consensus.round for block #${block._id}`);
                    consensus.round(0, block);
                    break;

                case MessageType.BLOCK_CONF_ROUND:
                    // we are receiving a consensus round confirmation
                    // it should come from one of the elected witnesses, so let's verify signature
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

                        if (steem) {
                            steem.receivePeerSyncStatus(message.d.nodeId, {
                                behindBlocks: message.d.behindBlocks,
                                isSyncing: message.d.isSyncing,
                                steemBlock: message.d.steemBlock,
                                blockId: message.d.blockId,
                                consensusBlocks: message.d.consensusBlocks,
                                exitTarget: message.d.exitTarget
                            });

                            logger.debug(`Received sync status from ${message.d.nodeId}: ${message.d.behindBlocks} blocks behind, isSyncing: ${message.d.isSyncing}`);
                        }
                    }
                    break;
            }
        });
    },

    recover: (): void => {
        if (!chain) {
            logger.warn('Chain service unavailable during recovery');
            return;
        }
        if (!p2p.sockets || p2p.sockets.length === 0) return;
        if (Object.keys(p2p.recoveredBlocks).length + p2p.recoveringBlocks.length > max_blocks_buffer) return;
        if (!p2p.recovering) p2p.recovering = chain.getLatestBlock()._id;
        const latestBlockId = chain.getLatestBlock()._id;
        let peersAhead: EnhancedWebSocket[] = [];
        for (const socket of p2p.sockets) {
            if (socket?.node_status?.head_block && socket.node_status.origin_block
                && socket.node_status.head_block > latestBlockId
                && socket.node_status.origin_block === config.read(0).originHash) {
                peersAhead.push(socket);
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
        const availablePeers = peersAhead.filter(peer => !retryInfo!.triedPeers.has(peer.node_status?.nodeId || ''));
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
        logger.info('Connected peers ' + p2p.sockets.length);
        // Don't refresh if we're shutting down
        if (!chain) {
            logger.warn('Chain service unavailable during refresh');
            return;
        }
        p2p.refreshAttempt++;

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
            const socket = p2p.sockets[i];
            const nodeStatus = socket.node_status;
            if (nodeStatus
                && nodeStatus.head_block > latestBlockId + 10
                && nodeStatus.origin_block === config.read(0)?.originHash) {
                peersAhead.push(socket);
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
                for (let y = 0; y < sentUs.length; y++) {
                    if (sentUs[y]?.[0] === d.s?.s) {
                        continue firstLoop;
                    }
                }
                p2p.sendJSON(p2p.sockets[i], d);
            }
        }
    },

    broadcast: (d: any): void => p2p.sockets.forEach(ws => p2p.sendJSON(ws, d)),

    broadcastBlock: (block: Block): void => {
        p2p.broadcast({ t: MessageType.NEW_BLOCK, d: block });
    },

    addRecursive: (block: Block): void => {
        chain.validateAndAddBlock(block, true, (err: any, newBlock: any) => {
            if (err) {
                cache.rollback();
                logger.warn(`[P2P] Failed to validate block ${newBlock._id}, clearing recovery cache`);
                p2p.recoveredBlocks = {};
                p2p.recoveringBlocks = [];
                p2p.recoverAttempt++;
                if (p2p.recoverAttempt > max_recover_attempts) {
                    logger.error(`[P2P] Error Replay - exceeded maximum recovery attempts for block ${newBlock._id}`);
                    p2p.recovering = false;
                    p2p.recoverAttempt = 0;
                    return;
                } else {
                    logger.debug(`[P2P] Recover attempt #${p2p.recoverAttempt} for block ${newBlock._id}`);
                    p2p.recovering = chain.getLatestBlock()._id;
                    p2p.recover();
                }
            } else {
                p2p.recoverAttempt = 0
                delete p2p.recoveredBlocks[newBlock._id]
                p2p.recover()
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
            if (!p2p.sockets[i].sentUs) continue;
            const sentUs = p2p.sockets[i].sentUs;
            if (!sentUs) continue;
            for (let y = 0; y < sentUs.length; y++)
                if (new Date().getTime() - sentUs[y][1] > keep_history_for) {
                    sentUs.splice(y, 1);
                    y--;
                }
        }
    }
};

export default p2p; 