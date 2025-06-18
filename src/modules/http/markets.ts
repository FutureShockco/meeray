import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint-utils.js';
import { ObjectId } from 'mongodb';
import { formatTokenAmountForResponse, formatTokenAmountSimple } from '../../utils/http-helpers.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

const transformPairData = (pairData: any): any => {
    if (!pairData) return pairData;
    const transformed = { ...pairData };
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    }
    
    // Format price and volume fields with proper decimals
    const priceFields = ['lastPrice', 'high24h', 'low24h', 'quoteMinPrice', 'quoteMaxPrice'];
    const volumeFields = ['volume24h', 'minTradeSize', 'maxTradeSize', 'baseMinSize', 'baseMaxSize'];
    const precisionFields = ['tickSize', 'stepSize'];
    
    // Format price fields using quote token decimals
    for (const field of priceFields) {
        if (transformed[field] && transformed.quoteSymbol) {
            const formatted = formatTokenAmountForResponse(transformed[field], transformed.quoteSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format volume fields using base token decimals
    for (const field of volumeFields) {
        if (transformed[field] && transformed.baseSymbol) {
            const formatted = formatTokenAmountForResponse(transformed[field], transformed.baseSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format precision fields (these are typically small decimals)
    for (const field of precisionFields) {
        if (transformed[field]) {
            transformed[field] = toBigInt(transformed[field]).toString();
        }
    }
    
    return transformed;
};

const transformOrderData = (orderData: any): any => {
    if (!orderData) return orderData;
    const transformed = { ...orderData };
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    }
    
    // Get the trading pair to determine token symbols for formatting
    const pairId = transformed.pairId;
    let baseSymbol = 'UNKNOWN';
    let quoteSymbol = 'UNKNOWN';
    
    // Try to get token symbols from the pair (this would need to be optimized in production)
    if (pairId) {
        // For now, we'll assume the pair ID contains the symbols or we can derive them
        // In a real implementation, you might want to cache this or join with pairs collection
        const pairParts = pairId.split('-');
        if (pairParts.length >= 2) {
            baseSymbol = pairParts[0];
            quoteSymbol = pairParts[1];
        }
    }
    
    // Format order amounts
    const priceFields = ['price'];
    const quantityFields = ['quantity', 'filledQuantity', 'remainingQuantity'];
    const costFields = ['cost', 'fee', 'total'];
    
    // Format price using quote token decimals
    for (const field of priceFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], quoteSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format quantity using base token decimals
    for (const field of quantityFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], baseSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format cost fields using quote token decimals
    for (const field of costFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], quoteSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    return transformed;
};

const transformTradeData = (tradeData: any): any => {
    if (!tradeData) return tradeData;
    const transformed = { ...tradeData };
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    }
    
    // Get the trading pair to determine token symbols for formatting
    const pairId = transformed.pairId;
    let baseSymbol = 'UNKNOWN';
    let quoteSymbol = 'UNKNOWN';
    
    if (pairId) {
        const pairParts = pairId.split('-');
        if (pairParts.length >= 2) {
            baseSymbol = pairParts[0];
            quoteSymbol = pairParts[1];
        }
    }
    
    // Format trade amounts
    const priceFields = ['price'];
    const quantityFields = ['quantity'];
    const costFields = ['buyerFee', 'sellerFee', 'cost', 'total'];
    
    // Format price using quote token decimals
    for (const field of priceFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], quoteSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format quantity using base token decimals
    for (const field of quantityFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], baseSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    // Format cost fields using quote token decimals
    for (const field of costFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], quoteSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    
    return transformed;
};

// --- Trading Pairs ---
router.get('/pairs', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const query: any = {};
    if (req.query.status) {
        query.status = req.query.status as string;
    }
    try {
        const pairsFromDB = await cache.findPromise('tradingPairs', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tradingPairs').countDocuments(query);
        const pairs = (pairsFromDB || []).map(transformPairData);
        res.json({ data: pairs, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching trading pairs:', error);
        res.status(500).json({ message: 'Error fetching trading pairs', error: error.message });
    }
}) as RequestHandler);

router.get('/pairs/:pairId', (async (req: Request, res: Response) => {
    const { pairId } = req.params;
    try {
        const pairFromDB = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pairFromDB) {
            return res.status(404).json({ message: `Trading pair ${pairId} not found.` });
        }
        const pair = transformPairData(pairFromDB);
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
        const ordersFromDB = await cache.findPromise('orders', query, { limit, skip, sort: { createdAt: -1 } });
        const total = await mongo.getDb().collection('orders').countDocuments(query);
        const orders = (ordersFromDB || []).map(transformOrderData);
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
        const ordersFromDB = await cache.findPromise('orders', query, { limit, skip, sort: { createdAt: -1 } });
        const total = await mongo.getDb().collection('orders').countDocuments(query);
        const orders = (ordersFromDB || []).map(transformOrderData);
        res.json({ data: orders, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching orders for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching orders for user', error: error.message });
    }
}) as RequestHandler);

router.get('/orders/:orderId', (async (req: Request, res: Response) => {
    const { orderId } = req.params;
    try {
        const orderFromDB = await cache.findOnePromise('orders', { _id: orderId });
        if (!orderFromDB) {
            return res.status(404).json({ message: `Order ${orderId} not found.` });
        }
        const order = transformOrderData(orderFromDB);
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
        const tradesFromDB = await cache.findPromise('trades', query, { limit, skip, sort: { timestamp: -1 } });
        const total = await mongo.getDb().collection('trades').countDocuments(query);
        const trades = (tradesFromDB || []).map(transformTradeData);
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
        const tradesFromDB = await cache.findPromise('trades', query, { limit, skip, sort: { timestamp: -1 }});
        const total = await mongo.getDb().collection('trades').countDocuments(query);

        const trades = (tradesFromDB || []).map(transformTradeData);
        
        if (trades.length === 0) {
            // If no trades are found for the orderId, check if the order itself exists before returning 404.
            // This helps differentiate between "no trades for this valid order" vs "order itself is invalid/not found".
            let orderExists = false;
            try {
                const orderObjectId = new ObjectId(orderId); // Attempt to convert to ObjectId
                orderExists = !!(await mongo.getDb().collection('orders').findOne({ _id: orderObjectId }));
            } catch (e) {
                // orderId is not a valid ObjectId string, so it can't be a direct _id match for an order.
                // If your orders can also be identified by a string ID that is NOT an ObjectId, 
                // you might need an additional check here, e.g. findOne({ stringOrderIdField: orderId })
                // For now, assume if it's not an ObjectId, it won't match an _id.
            }

            if (!orderExists) {
                return res.status(404).json({ message: `Order with ID ${orderId} not found.` });
            }
            // If order exists but has no trades, return empty trades list (HTTP 200)
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
        const tradeFromDB = await cache.findOnePromise('trades', { _id: tradeId });
        if (!tradeFromDB) {
            return res.status(404).json({ message: `Trade ${tradeId} not found.` });
        }
        const trade = transformTradeData(tradeFromDB);
        res.json(trade);
    } catch (error: any) {
        logger.error(`Error fetching trade ${tradeId}:`, error);
        res.status(500).json({ message: 'Error fetching trade', error: error.message });
    }
}) as RequestHandler);

export default router; 