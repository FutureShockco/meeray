import logger from '../logger.js';
import { EnhancedWebSocket, MessageType, SteemSyncStatus } from './types.js';
import { Block } from '../block.js';
import { P2P_CONFIG } from './config.js';

// Central socket communication utilities - stateless, works with provided sockets array
export class SocketManager {
    private static currentSockets: EnhancedWebSocket[] = [];

    // Set the current sockets array to work with
    static setSockets(sockets: EnhancedWebSocket[]): void {
        this.currentSockets = sockets;
    }

    static getSockets(): EnhancedWebSocket[] {
        return this.currentSockets;
    }

    // Core communication methods
    static sendJSON(ws: EnhancedWebSocket, data: any): void {
        if (ws.readyState === 1) { // WebSocket.OPEN
            try {
                ws.send(JSON.stringify(data));
            } catch (error) {
                logger.warn('Failed to send P2P message:', error);
            }
        }
    }

    static broadcast(data: any): void {
        const socketCount = this.currentSockets.length;
        logger.debug(`P2P broadcast: Sending to ${socketCount} connected sockets. Message type: ${data.t}`);
        this.currentSockets.forEach((ws: EnhancedWebSocket) => {
            if (ws.readyState === 1) {
                this.sendJSON(ws, data);
            }
        });
    }

    static broadcastNotSent(data: any): void {
        for (const socket of this.currentSockets) {
            if (socket.readyState !== 1) continue;

            if (!socket.sentUs) {
                this.sendJSON(socket, data);
                continue;
            }

            // Check by signature (old P2P behavior)
            let shouldSend = true;
            for (const sent of socket.sentUs) {
                if (sent[0] === data.s?.s) {
                    shouldSend = false;
                    break;
                }
            }
            
            if (shouldSend) {
                this.sendJSON(socket, data);
                // Note: Don't add to sentUs here - only when receiving (matches old P2P)
            }
        }
    }

    // Specialized broadcast methods
    static broadcastBlock(block: Block): void {
        this.broadcastNotSent({ t: MessageType.NEW_BLOCK, d: block });
    }

    static broadcastSyncStatus(syncStatus: SteemSyncStatus): void {
        this.broadcast({ t: MessageType.STEEM_SYNC_STATUS, d: syncStatus });
    }

    // Utility methods
    static cleanRoundConfHistory(): void {
        const now = Date.now();
        for (const socket of this.currentSockets) {
            if (!socket.sentUs) continue;
            for (let i = socket.sentUs.length - 1; i >= 0; i--) {
                if (now - socket.sentUs[i][1] > P2P_CONFIG.KEEP_HISTORY_FOR) {
                    socket.sentUs.splice(i, 1);
                }
            }
        }
    }

    // Query methods for easier access
    static getConnectedSockets(): EnhancedWebSocket[] {
        return this.currentSockets.filter((s: EnhancedWebSocket) => s.readyState === 1);
    }

    static getSocketsWithStatus(): EnhancedWebSocket[] {
        return this.currentSockets.filter((s: EnhancedWebSocket) => s.node_status);
    }

    static getSocketCount(): number {
        return this.currentSockets.length;
    }

    static getConnectedCount(): number {
        return this.getConnectedSockets().length;
    }
}
