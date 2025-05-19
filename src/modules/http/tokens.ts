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

// --- Tokens ---

// GET /tokens - List all registered tokens
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const tokens = await cache.findPromise('tokens', {}, { limit, skip, sort: { _id: 1 } }); // _id is symbol
        const total = await mongo.getDb().collection('tokens').countDocuments({});
        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching tokens:', error);
        res.status(500).json({ message: 'Error fetching tokens', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/:symbol - Get a specific token by its symbol
router.get('/:symbol', (async (req: Request, res: Response) => {
    const { symbol } = req.params;
    try {
        const token = await cache.findOnePromise('tokens', { _id: symbol }); // _id is symbol for tokens collection
        if (!token) {
            return res.status(404).json({ message: `Token ${symbol} not found.` });
        }
        res.json(token);
    } catch (error: any) {
        logger.error(`Error fetching token ${symbol}:`, error);
        res.status(500).json({ message: 'Error fetching token', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/issuer/:issuerName - List tokens created by a specific issuer
router.get('/issuer/:issuerName', (async (req: Request, res: Response) => {
    const { issuerName } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const tokens = await cache.findPromise('tokens', { issuer: issuerName }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tokens').countDocuments({ issuer: issuerName });
        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching tokens for issuer ${issuerName}:`, error);
        res.status(500).json({ message: 'Error fetching tokens by issuer', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/name/:searchName - Search for tokens by name (partial match)
router.get('/name/:searchName', (async (req: Request, res: Response) => {
    const { searchName } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        // Using a regex for partial matching on the 'name' field. 
        // Ensure the 'name' field is indexed for performance if this is a common query.
        const query = { name: { $regex: searchName, $options: 'i' } }; // 'i' for case-insensitive
        const tokens = await cache.findPromise('tokens', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tokens').countDocuments(query);
        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error searching tokens by name ${searchName}:`, error);
        res.status(500).json({ message: 'Error searching tokens by name', error: error.message });
    }
}) as RequestHandler);

export default router; 