import express, { Request, Response, Router, RequestHandler } from 'express';
import { chain } from '../../chain.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { transformTransactionData } from '../../utils/http-helpers.js';
import cache from '../../cache.js';

const router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

const transformBlockData = (block: any): any => {
    if (!block) return block;
    const { _id, txs, ...restOfBlock } = block;
    return {
        ...restOfBlock,
        id: _id.toString(),
        txs: txs ? txs.map((tx: any) => {
            const { _id: txId, data, ...restOfTx } = tx;
            const transformedTx: any = { ...restOfTx, data: transformTransactionData(data) };
            if (txId) {
                transformedTx.id = txId.toString();
            }
            return transformedTx;
        }) : []
    };
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
        
        const blocksFromDB = await mongo.getDb().collection('blocks')
            .find(query)
            .sort({ height: sortDirection })
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('blocks').countDocuments(query);

        const blocks = blocksFromDB.map(transformBlockData);
        
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
        const latestBlockFromChain = chain.getLatestBlock?.();
        if (!latestBlockFromChain) {
            return res.status(404).json({ error: 'No blocks found' });
        }
        // Assuming latestBlockFromChain structure is similar to DB structure
        const { transactions, _id, ...restOfBlock } = latestBlockFromChain;
        const transformedBlock: any = { ...restOfBlock };
        if (_id) { // _id might not exist if chain.getLatestBlock() returns a simplified object
            transformedBlock.id = _id.toString();
        }
        
        if (transactions && Array.isArray(transactions)) {
            transformedBlock.transactions = transactions.map((tx: any) => {
                const { data, ...restOfTx } = tx;
                return {
                    ...restOfTx,
                    data: transformTransactionData(data)
                };
            });
        }
        res.json({ success: true, block: transformedBlock });
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
        
        const blockFromDB = await mongo.getDb().collection('blocks').findOne({ height });
        
        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        
        const transformedBlock = transformBlockData(blockFromDB);
        res.json({ success: true, block: transformedBlock });
    } catch (err) {
        logger.error(`Error fetching block by height ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /blocks/hash/:hash - Get a block by its hash
router.get('/hash/:hash', (async (req: Request, res: Response) => {
    try {
        const hash = req.params.hash;
        
        const blockFromDB = await mongo.getDb().collection('blocks').findOne({ hash });
        
        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with hash ${hash} not found` });
        }
        
        const transformedBlock = transformBlockData(blockFromDB);
        res.json({ success: true, block: transformedBlock });
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
        
        const blockFromDB = await mongo.getDb().collection('blocks').findOne(
            { height },
            { projection: { transactions: 1, _id: 1 } } // Ensure _id is projected if needed for block ID
        );
        
        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        
        let transformedTransactions: any[] = [];
        if (blockFromDB.transactions && Array.isArray(blockFromDB.transactions)) {
            transformedTransactions = blockFromDB.transactions.map((tx: any) => {
                const { data, ...restOfTx } = tx;
                return {
                    ...restOfTx,
                    data: transformTransactionData(data)
                };
            });
        }

        res.json({ 
            success: true, 
            blockHeight: height,
            blockId: blockFromDB._id ? blockFromDB._id.toString() : undefined,
            transactions: transformedTransactions
        });
    } catch (err) {
        logger.error(`Error fetching transactions for block ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

export default router; 