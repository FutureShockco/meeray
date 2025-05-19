import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// --- Trading Pairs ---
router.get('/pairs', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const query: any = {};
    if (req.query.status) {
        query.status = req.query.status as string;
    }
    try {
        const pairs = await cache.findPromise('tradingPairs', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tradingPairs').countDocuments(query);
        res.json({ data: pairs, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching trading pairs:', error);
        res.status(500).json({ message: 'Error fetching trading pairs', error: error.message });
    }
}) as RequestHandler);

router.get('/pairs/:pairId', (async (req: Request, res: Response) => {
    const { pairId } = req.params;
    try {
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            return res.status(404).json({ message: `Trading pair ${pairId} not found.` });
        }
        res.json(pair);
    } catch (error: any) {
        logger.error(`Error fetching trading pair ${pairId}:`, error);
        res.status(500).json({ message: 'Error fetching trading pair', error: error.message });
    }
}) as RequestHandler);

// --- Orders ---
router.get('/orders/pair/:pairId', (async (req: Request, res: Response) => {
    const { pairId } = req.params;
    const { limit, skip } = getPagination(req);
    const query: any = { pairId };
    if (req.query.status) query.status = req.query.status as string;
    if (req.query.side) query.side = req.query.side as string;
    if (req.query.userId) query.userId = req.query.userId as string; // Allow filtering orders in a pair by user

    try {
        const orders = await cache.findPromise('orders', query, { limit, skip, sort: { createdAt: -1 } }); // Assuming createdAt for sorting
        const total = await mongo.getDb().collection('orders').countDocuments(query);
        res.json({ data: orders, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching orders for pair ${pairId}:`, error);
        res.status(500).json({ message: 'Error fetching orders for pair', error: error.message });
    }
}) as RequestHandler);

router.get('/orders/user/:userId', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);
    const query: any = { userId };
    if (req.query.pairId) query.pairId = req.query.pairId as string;
    if (req.query.status) query.status = req.query.status as string;
    if (req.query.side) query.side = req.query.side as string;

    try {
        const orders = await cache.findPromise('orders', query, { limit, skip, sort: { createdAt: -1 } });
        const total = await mongo.getDb().collection('orders').countDocuments(query);
        res.json({ data: orders, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching orders for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching orders for user', error: error.message });
    }
}) as RequestHandler);

router.get('/orders/:orderId', (async (req: Request, res: Response) => {
    const { orderId } = req.params;
    try {
        const order = await cache.findOnePromise('orders', { _id: orderId });
        if (!order) {
            return res.status(404).json({ message: `Order ${orderId} not found.` });
        }
        res.json(order);
    } catch (error: any) {
        logger.error(`Error fetching order ${orderId}:`, error);
        res.status(500).json({ message: 'Error fetching order', error: error.message });
    }
}) as RequestHandler);

// --- Trades ---
router.get('/trades/pair/:pairId', (async (req: Request, res: Response) => {
    const { pairId } = req.params;
    const { limit, skip } = getPagination(req);
    const query: any = { pairId };
    // Add time range filters if needed, e.g., ?fromTimestamp=...&toTimestamp=...
    if (req.query.fromTimestamp) query.timestamp = { $gte: parseInt(req.query.fromTimestamp as string) };
    if (req.query.toTimestamp) query.timestamp = { ...query.timestamp, $lte: parseInt(req.query.toTimestamp as string) };

    try {
        const trades = await cache.findPromise('trades', query, { limit, skip, sort: { timestamp: -1 } }); // Sort by newest first
        const total = await mongo.getDb().collection('trades').countDocuments(query);
        res.json({ data: trades, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching trades for pair ${pairId}:`, error);
        res.status(500).json({ message: 'Error fetching trades for pair', error: error.message });
    }
}) as RequestHandler);

// GET /markets/trades/order/:orderId - List trades involving a specific order ID (either as maker or taker)
router.get('/trades/order/:orderId', (async (req: Request, res: Response) => {
    const { orderId } = req.params;
    const { limit, skip } = getPagination(req);
    const query = {
        $or: [
            { makerOrderId: orderId },
            { takerOrderId: orderId }
        ]
    };
    try {
        const trades = await cache.findPromise('trades', query, { limit, skip, sort: { timestamp: -1 }});
        const total = await mongo.getDb().collection('trades').countDocuments(query);

        if (!trades || trades.length === 0) {
            return res.status(404).json({ message: `No trades found for order ID ${orderId}.` });
        }
        res.json({ data: trades, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching trades for order ${orderId}:`, error);
        res.status(500).json({ message: 'Error fetching trades for order', error: error.message });
    }
}) as RequestHandler);

// Get a specific trade by its ID (if trades have unique IDs)
// Assuming trades have a unique _id. If not, this endpoint might not be suitable.
router.get('/trades/:tradeId', (async (req: Request, res: Response) => {
    const { tradeId } = req.params;
    try {
        const trade = await cache.findOnePromise('trades', { _id: tradeId });
        if (!trade) {
            return res.status(404).json({ message: `Trade ${tradeId} not found.` });
        }
        res.json(trade);
    } catch (error: any) {
        logger.error(`Error fetching trade ${tradeId}:`, error);
        res.status(500).json({ message: 'Error fetching trade', error: error.message });
    }
}) as RequestHandler);

export default router; 