import express, { Request, Response, Router } from 'express';
import logger from '../../logger.js';
import notifications from '../../modules/notifications.js';
import kafkaConsumer from '../../modules/kafkaConsumer.js';

const router: Router = express.Router();

// GET /notifications/status
// Returns simple diagnostics about the notifications WS server and Kafka consumer
router.get('/status', async (req: Request, res: Response) => {
    try {
        const wsRunning = typeof notifications !== 'undefined';
        let wsClients = 0;
        try {
            wsClients = notifications.getConnectedCount();
        } catch (e) {
            logger.debug('[http/notifications] Could not get WS client count', e);
        }

        let consumerStatus: any = { connected: false, brokers: [] };
        try {
            if (kafkaConsumer && typeof kafkaConsumer.getConsumerStatus === 'function') {
                consumerStatus = kafkaConsumer.getConsumerStatus();
            } else {
                // best-effort: indicate consumer is present if initialize was called
                consumerStatus = { connected: !!(kafkaConsumer && kafkaConsumer.initializeKafkaConsumer), brokers: [] };
            }
        } catch (e) {
            logger.debug('[http/notifications] Could not get Kafka consumer status', e);
        }

        res.json({
            ws: { running: !!wsRunning, connectedClients: wsClients },
            kafkaConsumer: consumerStatus,
            timestamp: Date.now(),
        });
    } catch (err) {
        logger.error('[http/notifications] Error in /status handler:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /notifications/test-broadcast
// Body (optional): { topic?: string, d?: any }
// This triggers a broadcastNotification on the server for debugging.
router.post('/test-broadcast', async (req: Request, res: Response) => {
    try {
        const body = req.body || {};
        const topic = body.topic || process.env.KAFKA_TOPIC_NOTIFICATIONS || 'notifications';
        const d = body.d || { debug: true, message: 'test broadcast', ts: Date.now() };

    const forceAll = body.forceAll === true;
    const payload: any = { t: 'NOTIFICATION', topic, d };
    if (forceAll) payload._forceAll = true;

        try {
            notifications.broadcastNotification(payload);
        } catch (e) {
            logger.warn('[http/notifications] Failed to broadcast test payload:', e);
        }

        const clients = typeof notifications.getConnectedCount === 'function' ? notifications.getConnectedCount() : 0;
        res.json({ ok: true, payload, clients });
    } catch (err) {
        logger.error('[http/notifications] Error in /test-broadcast handler:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});
export default router;
