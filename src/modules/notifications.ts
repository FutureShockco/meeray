import { WebSocketServer, type WebSocket } from 'ws';
import logger from '../logger.js';
import { chain } from '../chain.js';
import config from '../config.js';
import mongo from '../mongo.js';
import { TransactionType } from '../transactions/types.js';

let wss: WebSocketServer | null = null;
const sockets: WebSocket[] = [];

export function initNotificationsServer(): Promise<void> {
    return new Promise((resolve) => {
        if (wss) {
            logger.info('[notifications] Notifications WS server already initialized.');
            return resolve();
        }

        const port = Number(process.env.NOTIFICATIONS_PORT) || 6005;
        wss = new WebSocketServer({ port });

        wss.on('connection', (ws: WebSocket) => {
            // Attach a simple subscriptions structure to each socket
            (ws as any)._subscriptions = { txIds: new Set<string>(), topics: new Set<string>() };

            sockets.push(ws);
            logger.info('[notifications] New UI client connected. Total sockets: ' + sockets.length);

            // Handle subscribe/unsubscribe messages from clients
            ws.on('message', (data: WebSocket.Data) => {
                try {
                    const text = typeof data === 'string' ? data : data.toString();
                    const msg = JSON.parse(text);
                    const subs = (ws as any)._subscriptions;
                    switch ((msg && msg.type) || '') {
                        case 'SUBSCRIBE_TRANSACTION':
                            if (msg.txId) {
                                subs.txIds.add(String(msg.txId));
                                ws.send(JSON.stringify({ type: 'SUBSCRIBED_TRANSACTION', txId: msg.txId }));
                                logger.debug(`[notifications] Socket subscribed to tx ${msg.txId}`);
                            }
                            break;
                        case 'UNSUBSCRIBE_TRANSACTION':
                            if (msg.txId) {
                                subs.txIds.delete(String(msg.txId));
                                ws.send(JSON.stringify({ type: 'UNSUBSCRIBED_TRANSACTION', txId: msg.txId }));
                                logger.debug(`[notifications] Socket unsubscribed from tx ${msg.txId}`);
                            }
                            break;
                        case 'SUBSCRIBE_TOPIC':
                            if (msg.topic) {
                                subs.topics.add(String(msg.topic));
                                ws.send(JSON.stringify({ type: 'SUBSCRIBED_TOPIC', topic: msg.topic }));
                                logger.debug(`[notifications] Socket subscribed to topic ${msg.topic}`);
                            }
                            break;
                        case 'UNSUBSCRIBE_TOPIC':
                            if (msg.topic) {
                                subs.topics.delete(String(msg.topic));
                                ws.send(JSON.stringify({ type: 'UNSUBSCRIBED_TOPIC', topic: msg.topic }));
                                logger.debug(`[notifications] Socket unsubscribed from topic ${msg.topic}`);
                            }
                            break;
                        case 'CLEAR_SUBSCRIPTIONS':
                            subs.txIds.clear();
                            subs.topics.clear();
                            ws.send(JSON.stringify({ type: 'CLEARED_SUBSCRIPTIONS' }));
                            break;
                        default:
                            // unknown message types are ignored for now
                            break;
                    }
                } catch (e) {
                    logger.debug('[notifications] Failed to parse WS message from client:', e);
                }
            });

            ws.on('close', () => {
                const idx = sockets.indexOf(ws);
                if (idx !== -1) sockets.splice(idx, 1);
                logger.info('[notifications] UI client disconnected. Total sockets: ' + sockets.length);
            });

            ws.on('error', (err) => {
                logger.warn('[notifications] WebSocket error:', err);
            });
        });

        wss.on('listening', () => {
            logger.info(`[notifications] Notifications WebSocket server listening on port ${port}`);
            resolve();
        });

        wss.on('error', (err) => {
            logger.error('[notifications] WebSocket server error:', err);
            // still resolve to avoid blocking startup; kafka consumer will still try to run
            resolve();
        });
    });
}

export function broadcastNotification(payload: any): void {
    try {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        // Extract txId or fallback to nested fields if present
        const txIdFromPayload =
            payload && payload.d && (payload.d.transactionId || payload.d._id || payload.d.txId) ? String(payload.d.transactionId || payload.d._id || payload.d.txId) : null;
        const topicFromPayload = payload && payload.topic ? String(payload.topic) : null;

        for (const ws of sockets) {
            if ((ws as any).readyState !== 1) continue;
            try {
                const subs = (ws as any)._subscriptions;
                // If socket has no subscriptions or has matching topic/txId, deliver
                const hasSubs = subs && (subs.txIds.size > 0 || subs.topics.size > 0);
                let shouldSend = false;
                if (!hasSubs) shouldSend = true;
                else {
                    if (txIdFromPayload && subs.txIds.has(txIdFromPayload)) shouldSend = true;
                    if (topicFromPayload && subs.topics.has(topicFromPayload)) shouldSend = true;
                }

                if (shouldSend) ws.send(data);
            } catch (err) {
                logger.warn('[notifications] Failed to send to a socket:', err);
            }
        }
    } catch (err) {
        logger.error('[notifications] Error broadcasting notification:', err);
    }
}

export function getConnectedCount(): number {
    return sockets.filter(s => (s as any).readyState === 1).length;
}

export async function closeNotificationsServer(): Promise<void> {
    if (!wss) return;
    try {
        for (const ws of sockets) {
            try { ws.close(); } catch (e) {}
        }
        await new Promise<void>((resolve) => wss!.close(() => resolve()));
        logger.info('[notifications] Notifications WebSocket server closed.');
    } catch (err) {
        logger.error('[notifications] Error closing WebSocket server:', err);
    } finally {
        wss = null;
        sockets.length = 0;
    }
}

// Reintroduce DB-backed notifications processing used by the node (internal)
const isEnabled = process.env.NOTIFICATIONS === 'true' || false;

const dbNotifications = {
    processBlock: async (block: any) => {
        if (
            !isEnabled ||
            (chain.restoredBlocks && chain.getLatestBlock()._id + config.notifPurge * config.notifPurgeAfter < chain.restoredBlocks)
        )
            return;

        if (block._id % config.notifPurge === 0) await notifications.purgeOld(block);

        for (let i = 0; i < block.txs.length; i++) await notifications.processTx(block.txs[i], block.timestamp);
    },
    purgeOld: async (block: any) => {
        const threshold = block.timestamp - config.notifPurge * config.notifPurgeAfter * config.blockTime;
        await mongo
            .getDb()
            .collection('notifications')
            .deleteMany({
                ts: { $lt: threshold },
            });
    },
    processTx: async (tx: any, ts: number) => {
        let notif: any = {};
        switch (tx.type) {
            case TransactionType.TOKEN_CREATE: {
                const tokenCreateData = tx.data;
                if (tokenCreateData.issuer) {
                    notif = {
                        u: tokenCreateData.issuer,
                        tx: tx,
                        ts: ts,
                    };
                    await mongo.getDb().collection('notifications').insertOne(notif);
                }
                break;
            }
            case TransactionType.TOKEN_TRANSFER: {
                const tokenTransferData = tx.data;
                notif = {
                    u: tokenTransferData.receiver,
                    tx: tx,
                    ts: ts,
                };
                await mongo.getDb().collection('notifications').insertOne(notif);
                break;
            }
            default:
                break;
        }
    },
};

// Compose a single notifications module that contains both the WS server helpers
// and the DB-backed processing functions. Export as both default and named export.
const notifications = {
    initNotificationsServer,
    broadcastNotification,
    getConnectedCount,
    closeNotificationsServer,
    // DB functions
    processBlock: dbNotifications.processBlock,
    purgeOld: dbNotifications.purgeOld,
    processTx: dbNotifications.processTx,
};

export { notifications };
export default notifications;

