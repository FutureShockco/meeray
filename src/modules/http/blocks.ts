import express, { Request, Response, Router, RequestHandler } from 'express';
import { chain } from '../../chain.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';

const router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// GET /blocks - Get a range of blocks with pagination
router.get('/', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        
        // Allow filtering by transaction type if needed
        const query: any = {};
        
        if (req.query.hasTransactionType) {
            query['transactions.type'] = parseInt(req.query.hasTransactionType as string);
        }
        
        if (req.query.minTimestamp) {
            query.timestamp = { $gte: parseInt(req.query.minTimestamp as string) };
        }
        
        if (req.query.maxTimestamp) {
            if (!query.timestamp) query.timestamp = {};
            query.timestamp.$lte = parseInt(req.query.maxTimestamp as string);
        }
        
        // Sort by height (most recent first by default)
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        
        const blocks = await mongo.getDb().collection('blocks')
            .find(query)
            .sort({ height: sortDirection })
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('blocks').countDocuments(query);
        
        res.json({ 
            success: true, 
            data: blocks, 
            total,
            limit,
            skip
        });
    } catch (err) {
        logger.error('Error fetching blocks:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /blocks/latest - Returns the latest block
router.get('/latest', ((_req: Request, res: Response) => {
    try {
        const latestBlock = chain.getLatestBlock?.();
        if (!latestBlock) {
            return res.status(404).json({ error: 'No blocks found' });
        }
        res.json({ success: true, block: latestBlock });
    } catch (err) {
        logger.error('Error fetching latest block:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /blocks/height/:height - Get a block by its height
router.get('/height/:height', (async (req: Request, res: Response) => {
    try {
        const height = parseInt(req.params.height);
        
        if (isNaN(height)) {
            return res.status(400).json({ error: 'Invalid block height. Must be a number.' });
        }
        
        const block = await mongo.getDb().collection('blocks').findOne({ height });
        
        if (!block) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        
        res.json({ success: true, block });
    } catch (err) {
        logger.error(`Error fetching block by height ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /blocks/hash/:hash - Get a block by its hash
router.get('/hash/:hash', (async (req: Request, res: Response) => {
    try {
        const hash = req.params.hash;
        
        const block = await mongo.getDb().collection('blocks').findOne({ hash });
        
        if (!block) {
            return res.status(404).json({ error: `Block with hash ${hash} not found` });
        }
        
        res.json({ success: true, block });
    } catch (err) {
        logger.error(`Error fetching block by hash ${req.params.hash}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /blocks/:height/transactions - Get transactions in a specific block
router.get('/:height/transactions', (async (req: Request, res: Response) => {
    try {
        const height = parseInt(req.params.height);
        
        if (isNaN(height)) {
            return res.status(400).json({ error: 'Invalid block height. Must be a number.' });
        }
        
        const block = await mongo.getDb().collection('blocks').findOne(
            { height },
            { projection: { transactions: 1 } }
        );
        
        if (!block) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        
        res.json({ 
            success: true, 
            blockHeight: height,
            transactions: block.transactions || []
        });
    } catch (err) {
        logger.error(`Error fetching transactions for block ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

export default router; 