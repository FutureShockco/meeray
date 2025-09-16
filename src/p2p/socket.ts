import logger from '../logger.js';
import { EnhancedWebSocket, MessageType, SteemSyncStatus } from './types.js';
import { Block } from '../block.js';
import { P2P_CONFIG } from './config.js';

// Central socket communication utilities - THE single source of truth for all P2P communication
export class SocketManager {
    private static sockets: EnhancedWebSocket[] = [];

    // Core socket management
    static setSockets(sockets: EnhancedWebSocket[]): void {
        this.sockets = sockets;
    }

    static getSockets(): EnhancedWebSocket[] {
        return this.sockets;
    }

    // Remove individual socket management since we'll use setSockets to sync
    // static addSocket and removeSocket are no longer needed since we sync via setSockets

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
        const socketCount = this.sockets.length;
        logger.debug(`P2P broadcast: Sending to ${socketCount} connected sockets. Message type: ${data.t}`);
        this.sockets.forEach(ws => {
            if (ws.readyState === 1) {
                this.sendJSON(ws, data);
            }
        });
    }

    static broadcastNotSent(data: any): void {
        for (const socket of this.sockets) {
            if (socket.readyState !== 1) continue;

            if (!socket.sentUs) {
                this.sendJSON(socket, data);
                socket.sentUs = [[data.s?.s || JSON.stringify(data), Date.now()]];
                continue;
            }

            // Check by signature first (old P2P behavior), fallback to full message
            const signature = data.s?.s;
            let alreadySent = false;
            
            if (signature) {
                alreadySent = socket.sentUs.some(([sent]) => sent === signature);
            } else {
                const dataStr = JSON.stringify(data);
                alreadySent = socket.sentUs.some(([sent]) => sent === dataStr);
            }
            
            if (!alreadySent) {
                this.sendJSON(socket, data);
                socket.sentUs.push([signature || JSON.stringify(data), Date.now()]);
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
        for (const socket of this.sockets) {
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
        return this.sockets.filter(s => s.readyState === 1);
    }

    static getSocketsWithStatus(): EnhancedWebSocket[] {
        return this.sockets.filter(s => s.node_status);
    }

    static getSocketCount(): number {
        return this.sockets.length;
    }

    static getConnectedCount(): number {
        return this.getConnectedSockets().length;
    }
}
