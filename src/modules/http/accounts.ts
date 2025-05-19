import express, { Request, Response, Router, RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import mongo from '../../mongo.js';
import cache from '../../cache.js';
import logger from '../../logger.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// GET /accounts - List accounts with pagination and filtering
router.get('/', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        const query: any = {};
        
        // Filter by tokenBalance (accounts holding a specific token)
        if (req.query.hasToken) {
            const tokenSymbol = req.query.hasToken as string;
            query[`tokens.${tokenSymbol}`] = { $exists: true, $gt: 0 };
        }
        
        // Filter by witness status
        if (req.query.isWitness === 'true') {
            query.witnessPublicKey = { $exists: true, $ne: '' };
        }
        
        // Set up sort parameters
        const sortField = req.query.sortBy as string || 'name';
        const sortDirection = req.query.sortDirection === 'desc' ? -1 : 1;
        const sort: any = {};
        sort[sortField] = sortDirection;
        
        const accounts = await mongo.getDb().collection('accounts')
            .find(query)
            .sort(sort)
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('accounts').countDocuments(query);
        
        res.json({ success: true, data: accounts, total, limit, skip });
    } catch (err) {
        logger.error('Error fetching accounts list:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /accounts/:name - Get a specific account by name
router.get('/:name', (async (req: Request, res: Response) => {
    try {
        if (!req.params.name || typeof req.params.name !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid account name format.' });
        }
        let accountId;
        try {
            accountId = new ObjectId(req.params.name);
        } catch (e) {
            // If req.params.name is not a valid ObjectId string, it might be a name string for a lookup.
            // Assuming _id in 'accounts' collection can be EITHER an ObjectId OR a string name based on context.
            // The error specifically mentions ObjectId, so for this query, we prioritize ObjectId.
            // If it was intended to search by a field other than _id (like a 'name' field), the query should be { name: req.params.name }
            // For now, if it is not a valid ObjectId, it will fail the query if _id is strictly ObjectId.
            // If _id is expected to be string for some documents and ObjectId for others, this is complex.
            // Given the error, it seems _id IS an ObjectId for the documents it's trying to find.
            // Let's assume for now that if it's not an ObjectId, we try finding by a field called 'name'.
            // However, the original code was findOne({ _id: req.params.name }), implying _id lookup.
            // So, if it fails to be an ObjectId, it's an invalid _id for this specific lookup.
             return res.status(400).json({ success: false, error: 'Invalid account ID format for _id lookup.' });
        }
        const account = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        if (!account) {
            // If not found by ObjectId, perhaps try by name if that's a fallback?
            // For now, stick to the original intention which was _id lookup.
            const accountByName = await mongo.getDb().collection('accounts').findOne({ name: req.params.name });
            if (!accountByName) {
                 return res.status(404).json({ success: false, error: 'Account not found by ID or name.' });
            }
            return res.json({ success: true, account: accountByName });
        }
        res.json({ success: true, account });
    } catch (err) {
        logger.error(`Error fetching account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /accounts/:name/transactions - Get transactions involving an account
router.get('/:name/transactions', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        const accountName = req.params.name;
        
        // Check if account exists - here we can try by ObjectId first, then by name string if _id might not be ObjectId.
        // The error was on findOne({_id: accountName}), so we should assume _id is an ObjectId
        let accountExists;
        try {
            const accountId = new ObjectId(accountName);
            accountExists = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        } catch (e) {
            // If accountName is not an ObjectId string, it might be a name. Try finding by name.
            accountExists = await mongo.getDb().collection('accounts').findOne({ name: accountName });
        }

        if (!accountExists) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        
        // For transactions, the query is on 'sender' which is likely a string name.
        const query: { sender: string; type?: number } = { sender: accountName }; // Explicitly type query
        
        // Filter by transaction type if requested
        if (req.query.type) {
            query['type'] = parseInt(req.query.type as string);
        }
        
        // Get transactions from most recent to oldest
        const transactions = await mongo.getDb().collection('transactions')
            .find(query)
            .sort({ ts: -1 })
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('transactions').countDocuments(query);
        
        res.json({ 
            success: true, 
            data: transactions,
            total,
            limit,
            skip
        });
    } catch (err) {
        logger.error(`Error fetching transactions for account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /accounts/:name/tokens - Get all tokens held by an account
router.get('/:name/tokens', (async (req: Request, res: Response) => {
    try {
        const accountName = req.params.name;
        let account;
        try {
            const accountId = new ObjectId(accountName);
            account = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        } catch (e) {
            account = await mongo.getDb().collection('accounts').findOne({ name: accountName });
        }
        
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        
        const tokens = account.tokens || {};
        
        const tokenBalances = Object.entries(tokens).map(([symbol, amount]) => ({
            symbol,
            amount
        }));
        
        res.json({
            success: true,
            account: accountName,
            tokens: tokenBalances
        });
    } catch (err) {
        logger.error(`Error fetching token balances for account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

export default router; 