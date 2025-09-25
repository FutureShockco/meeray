import { chain } from '../chain.js';
import config from '../config.js';
import logger from '../logger.js';
import { P2P_CONFIG } from './config.js';
import { SocketManager } from './socket.js';
import { MessageType, P2PState } from './types.js';

export class RecoveryManager {
    private state: P2PState;

    constructor(state: P2PState) {
        this.state = state;
    }

    recover(): void {
        if (!SocketManager.getSocketCount()) return;
        if (Object.keys(this.state.recoveredBlocks).length + this.state.recoveringBlocks.length > P2P_CONFIG.MAX_BLOCKS_BUFFER) return;

        if (!this.state.recovering) {
            this.state.recovering = chain.getLatestBlock()._id;
        }

        const currentBlock = chain.getLatestBlock()._id;
        logger.trace('Current block:', currentBlock);

        // Debug each socket's status
        SocketManager.getSockets().forEach((socket, index) => {
            logger.trace(`Peer ${index}:`, {
                hasNodeStatus: !!socket.node_status,
                headBlock: socket.node_status?.head_block,
                originBlock: socket.node_status?.origin_block,
                isAhead: socket.node_status ? socket.node_status.head_block > currentBlock : false,
                originMatches: socket.node_status?.origin_block === config.originHash,
            });
        });

        const peersAhead = SocketManager.getSockets().filter(
            socket => socket.node_status && socket.node_status.head_block > chain.getLatestBlock()._id && socket.node_status.origin_block === config.originHash
        );

        if (peersAhead.length === 0) {
            this.state.recovering = false;
            return;
        }

        const champion = peersAhead[Math.floor(Math.random() * peersAhead.length)];
        const nextBlock = (this.state.recovering as number) + 1;

        // Ensure champion has node_status before proceeding
        if (!champion.node_status) {
            logger.warn('[P2P] Champion peer has no node_status, skipping recovery');
            return;
        }

        if (nextBlock <= champion.node_status.head_block) {
            this.state.recovering = nextBlock;
            SocketManager.sendJSON(champion, { t: MessageType.QUERY_BLOCK, d: nextBlock });
            this.state.recoveringBlocks.push(nextBlock);

            logger.trace(`Querying block #${nextBlock} from peer (head: ${champion.node_status.head_block})`);

            if (nextBlock % 2) {
                this.recover();
            }
        }
    }

    refresh(force: boolean = false): void {
        if (this.state.recovering && !force) return;

        for (const socket of SocketManager.getSockets()) {
            if (
                socket.node_status &&
                socket.node_status.head_block > chain.getLatestBlock()._id + 10 &&
                socket.node_status.origin_block === config.originHash
            ) {
                logger.info(`Catching up with network, peer head block: ${socket.node_status.head_block}`);
                this.state.recovering = chain.getLatestBlock()._id;
                this.recover();
                break;
            }
        }
    }

    startRecovery(): void {
        if (!this.state.recovering) {
            this.state.recovering = chain.getLatestBlock()._id;
        }
        this.recover();
    }

    stopRecovery(): void {
        this.state.recovering = false;
        this.state.recoverAttempt = 0;
        this.state.recoveringBlocks = [];
    }

    isRecovering(): boolean {
        return !!this.state.recovering;
    }
}
