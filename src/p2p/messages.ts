import secp256k1 from 'secp256k1';
import baseX from 'base-x';
import logger from '../logger.js';
import config from '../config.js';
import cache from '../cache.js';
import consensus from '../consensus.js';
import steem from '../steem.js';
import mongo from '../mongo.js';
import { chain } from '../chain.js';
import { blocks } from '../blockStore.js';
import { Block } from '../block.js';

import { 
    EnhancedWebSocket, 
    P2PState, 
    MessageType,
    SteemSyncStatus 
} from './types.js';
import { P2P_CONFIG, P2P_RUNTIME_CONFIG } from './config.js';
import { SocketManager } from './socket.js';
import { PeerDiscovery } from './discovery.js';

const bs58 = baseX(config.b58Alphabet || '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

export class MessageHandler {
    private state: P2PState;
    private peerDiscovery: PeerDiscovery;

    constructor(state: P2PState, peerDiscovery: PeerDiscovery) {
        this.state = state;
        this.peerDiscovery = peerDiscovery;
    }

    setupMessageHandler(ws: EnhancedWebSocket): void {
        logger.debug('Setting up message handler for websocket');
        ws.on('message', (data) => {
            logger.debug('Received P2P message:', data.toString().substring(0, 100));
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
                    this.handleNodeStatusQuery(ws, message);
                    break;

                case MessageType.NODE_STATUS:
                    this.handleNodeStatus(ws, message);
                    break;

                case MessageType.QUERY_BLOCK:
                    this.handleBlockQuery(ws, message);
                    break;

                case MessageType.BLOCK:
                    this.handleBlock(ws, message);
                    break;

                case MessageType.NEW_BLOCK:
                    this.handleNewBlock(ws, message);
                    break;

                case MessageType.BLOCK_CONF_ROUND:
                    this.handleBlockConfRound(ws, message);
                    break;

                case MessageType.STEEM_SYNC_STATUS:
                    this.handleSteemSyncStatus(ws, message);
                    break;

                case MessageType.QUERY_PEER_LIST:
                    this.peerDiscovery.handlePeerListQuery(ws, message);
                    break;

                case MessageType.PEER_LIST:
                    this.peerDiscovery.handlePeerList(ws, message);
                    break;
            }
        });
    }

    handleNodeStatusQuery(ws: EnhancedWebSocket, message: any): void {
        logger.debug('Received QUERY_NODE_STATUS:', message.d);
        
        if (typeof message.d?.nodeId !== 'string' || typeof message.d?.random !== 'string') {
            logger.warn('Invalid QUERY_NODE_STATUS format:', message.d);
            return;
        }

        const wsNodeId = message.d.nodeId;
        if (wsNodeId === this.state.nodeId?.pub) {
            logger.debug('Peer disconnected: same P2P ID');
            ws.close();
            return;
        }

        const wsIndex = this.state.sockets.indexOf(ws);
        if (wsIndex !== -1) {
            const receivedChallenge = message.d.random;
            // Store the challenge they sent us for signing our response
            ws.receivedChallenge = receivedChallenge;

            const latestBlock = chain.getLatestBlock();
            
            // Sign the challenge hash they sent us to prove we own our nodeId
            let signature = '';
            if (this.state.nodeId?.priv) {
                try {
                    const sigObj = secp256k1.ecdsaSign(Buffer.from(receivedChallenge, 'hex'), bs58.decode(this.state.nodeId.priv));
                    signature = bs58.encode(sigObj.signature);
                } catch (error) {
                    logger.error('Failed to sign challenge:', error);
                    ws.close();
                    return;
                }
            }

            SocketManager.sendJSON(ws, {
                t: MessageType.NODE_STATUS,
                d: {
                    nodeId: this.state.nodeId?.pub || '',
                    head_block: latestBlock._id,
                    head_block_hash: latestBlock.hash,
                    previous_block_hash: latestBlock.phash,
                    origin_block: config.originHash,
                    version: P2P_CONFIG.VERSION,
                    sign: signature
                }
            });
            
            logger.debug('Sent NODE_STATUS response with signature');
        }
    }

    handleNodeStatus(ws: EnhancedWebSocket, message: any): void {
        logger.debug('Received NODE_STATUS:', message.d);
        
        if (typeof message.d?.sign !== 'string') {
            logger.warn('NODE_STATUS missing signature:', message.d);
            return;
        }

        const wsIndex = this.state.sockets.indexOf(ws);
        if (wsIndex === -1) return;

        // Use the challenge we sent to them (not the one they sent to us)
        const challengeHash = this.state.sockets[wsIndex].challengeHash;
        if (!challengeHash) {
            logger.warn('No challengeHash found for signature verification');
            return;
        }

        console.log('=== SIGNATURE VERIFICATION DEBUG ===');
        console.log('Our challenge hash:', challengeHash);
        console.log('Their nodeId:', message.d.nodeId);
        console.log('Their signature:', message.d.sign);
        console.log('Challenge buffer:', Buffer.from(challengeHash, 'hex'));
        console.log('NodeId decoded length:', bs58.decode(message.d.nodeId || '').length);

        if (message.d.origin_block !== config.originHash) {
            logger.debug('Different chain ID, disconnecting');
            ws.close();
            return;
        }

        try {
            const isValidSignature = secp256k1.ecdsaVerify(
                bs58.decode(message.d.sign),
                Buffer.from(challengeHash, 'hex'),
                bs58.decode(message.d.nodeId || '')
            );

            console.log('Signature verification result:', isValidSignature);

            if (!isValidSignature) {
                logger.warn('Wrong NODE_STATUS signature, disconnecting');
                ws.close();
                return;
            }

            // Remove duplicate connections
            for (let i = 0; i < this.state.sockets.length; i++) {
                if (i !== wsIndex &&
                    this.state.sockets[i].node_status &&
                    this.state.sockets[i].node_status?.nodeId === message.d.nodeId) {
                    logger.debug('Peer disconnected: duplicate connection');
                    this.state.sockets[i].close();
                }
            }

            if (this.state.sockets[wsIndex].pendingDisconnect) {
                clearTimeout(this.state.sockets[wsIndex].pendingDisconnect);
            }

            delete message.d.sign;
            this.state.sockets[wsIndex].node_status = message.d;

            logger.debug(`Peer connection established successfully with nodeId: ${message.d.nodeId}`);

        } catch (error) {
            logger.error('Error during NODE_STATUS verification:', error);
        }
    }

    async handleBlockQuery(ws: EnhancedWebSocket, message: any): Promise<void> {
        const blockId = message.d;
        if (typeof blockId !== 'number') {
            logger.warn('Invalid block ID type:', typeof blockId);
            return;
        }

        let block = null;

        // Try blocks store first
        try {
            block = blocks.readOne(blockId);
        } catch (error) {
            logger.debug('Block', blockId, 'not found in blocks store');
        }

        // Try MongoDB if blocks store fails
        if (!block) {
            try {
                block = await mongo.getDb().collection<Block>('blocks').findOne({ _id: blockId });
                if (!block) {
                    logger.warn('Block', blockId, 'not found in MongoDB either');
                    return;
                }
            } catch (error) {
                logger.error('Error querying MongoDB for block', blockId, ':', error);
                return;
            }
        }

        if (block) {
            SocketManager.sendJSON(ws, { t: MessageType.BLOCK, d: block });
        }
    }

    handleBlock(ws: EnhancedWebSocket, message: any): void {
        const block = message.d;
        if (!block || typeof block._id !== 'number') return;

        const wsIndex = this.state.sockets.indexOf(ws);
        if (wsIndex === -1) return;

        // Update peer's head block info
        this.state.sockets[wsIndex].node_status!.head_block = block._id;
        this.state.sockets[wsIndex].node_status!.head_block_hash = block.hash;
        this.state.sockets[wsIndex].node_status!.previous_block_hash = block.phash;

        if (this.state.recovering) return;

        consensus.round(0, block);
    }

    handleNewBlock(ws: EnhancedWebSocket, message: any): void {
        const block = message.d;
        if (!block || typeof block._id !== 'number') return;

        const wsIndex = this.state.sockets.indexOf(ws);
        if (wsIndex === -1) return;

        // Update peer's head block info
        this.state.sockets[wsIndex].node_status!.head_block = block._id;
        this.state.sockets[wsIndex].node_status!.head_block_hash = block.hash;
        this.state.sockets[wsIndex].node_status!.previous_block_hash = block.phash;

        if (this.state.recovering) return;

        consensus.round(0, block);
    }

    handleBlockConfRound(ws: EnhancedWebSocket, message: any): void {
        logger.debug(`Received BLOCK_CONF_ROUND from ${message.s?.n}: round=${message.d?.r}, block hash=${message.d?.b?.hash}`);
        if (this.state.recovering) return;
        if (!message.s?.s || !message.s?.n || !message.d?.ts) return;

        const now = Date.now();
        if (message.d.ts + 2 * config.blockTime < now ||
            message.d.ts - 2 * config.blockTime > now) return;

        const wsIndex = this.state.sockets.indexOf(ws);
        if (wsIndex !== -1) {
            if (!this.state.sockets[wsIndex].sentUs) {
                this.state.sockets[wsIndex].sentUs = [];
            }
            this.state.sockets[wsIndex].sentUs!.push([message.s.s, now]);
        }

        // Check if already processed
        for (const processed of consensus.processed || []) {
            if (processed[0]?.s?.s === message.s.s) return;
        }

        // Add to processed list
        if (!consensus.processed) consensus.processed = [];
        consensus.processed.push([message, now]);

        // Broadcast to other peers
        SocketManager.broadcastNotSent(message);

        // Process in consensus - follow the old P2P logic
        logger.debug(`P2P calling consensus.round with block data:`, JSON.stringify(message.d.b));
        consensus.round(0, message.d.b, (validationStep: number) => {
            logger.debug(`P2P consensus.round callback: validationStep=${validationStep}`);
            if (validationStep === 0) {
                if (!consensus.queue) consensus.queue = [];
                consensus.queue.push(message);
            } else if (validationStep > 0) {
                logger.debug(`P2P calling consensus.remoteRoundConfirm`);
                consensus.remoteRoundConfirm(message);
            } else {
                logger.debug(`P2P consensus.round validation failed with step=${validationStep}`);
            }
        });
    }

    handleSteemSyncStatus(ws: EnhancedWebSocket, message: any): void {
        const syncStatus: SteemSyncStatus = message.d;
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

            for (const socket of this.state.sockets) {
                if (socket !== ws && socket.node_status?.nodeId !== syncStatus.nodeId) {
                    SocketManager.sendJSON(socket, relayedMessage);
                }
            }
        }
    }

    addRecursive(block: Block): void {
        if (this.state.recoverAttempt > P2P_CONFIG.MAX_RECOVER_ATTEMPTS) {
            logger.error('Too many recovery attempts, stopping');
            this.state.recovering = false;
            this.state.recoverAttempt = 0;
            return;
        }

        const targetBlockId = chain.getLatestBlock()._id + 1;
        if (block._id !== targetBlockId) {
            logger.warn(`Expected block ${targetBlockId}, got ${block._id}. Storing for later.`);
            this.state.recoveredBlocks[block._id] = block;
            return;
        }

        chain.validateAndAddBlock(block, true, (newBlock: Block | null) => {
            if (!newBlock) {
                this.state.recoverAttempt++;
                logger.warn(`Block validation failed. Attempt ${this.state.recoverAttempt}/${P2P_CONFIG.MAX_RECOVER_ATTEMPTS}`);
                
                if (this.state.recoverAttempt <= P2P_CONFIG.MAX_RECOVER_ATTEMPTS) {
                    // Retry logic would go here
                } else {
                    this.state.recovering = false;
                    this.state.recoverAttempt = 0;
                }
            } else {
                this.state.recoverAttempt = 0;
                if (newBlock) {
                    delete this.state.recoveredBlocks[newBlock._id];
                }
                // Trigger recovery for next block
                // recover() would be called here

                // Process next block if available
                const nextBlockId = chain.getLatestBlock()._id + 1;
                if (this.state.recoveredBlocks[nextBlockId]) {
                    setTimeout(() => {
                        if (this.state.recoveredBlocks[nextBlockId]) {
                            this.addRecursive(this.state.recoveredBlocks[nextBlockId]);
                        }
                    }, 1);
                }
            }
        });
    }

}
