import express, { Request, Response, Router, RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import mongo from '../../mongo.js';
import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import { transformTransactionData, formatTokenBalancesForResponse } from '../../utils/http.js';

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
        
        const accountsFromDB: any[] = await mongo.getDb().collection('accounts')
            .find(query)
            .sort(sort)
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('accounts').countDocuments(query);

        const accounts = accountsFromDB.map(acc => {
            const { _id, totalVoteWeight, balances, ...rest } = acc;
            const transformedAcc: any = { ...rest };
            if (_id) {
                transformedAcc.id = _id.toString();
            }
            if (totalVoteWeight) {
                transformedAcc.totalVoteWeight = toBigInt(totalVoteWeight as string).toString();
            }
            if (balances) {
                // Format token balances with proper decimals
                transformedAcc.balances = formatTokenBalancesForResponse(balances);
            }
            return transformedAcc;
        });
        
        res.json({ success: true, data: accounts, total, limit, skip });
    } catch (err) {
        logger.error('Error fetching accounts list:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /accounts/count - Get total number of accounts
router.get('/count', (async (req: Request, res: Response) => {
    try {
        const query: any = {};
        
        // Apply the same filters as the main accounts endpoint if provided
        if (req.query.hasToken) {
            const tokenSymbol = req.query.hasToken as string;
            query[`tokens.${tokenSymbol}`] = { $exists: true, $gt: 0 };
        }
        
        if (req.query.isWitness === 'true') {
            query.witnessPublicKey = { $exists: true, $ne: '' };
        }
        
        const totalAccounts = await mongo.getDb().collection('accounts').countDocuments(query);
        
        res.json({ 
            success: true, 
            count: totalAccounts,
            filters: {
                hasToken: req.query.hasToken || null,
                isWitness: req.query.isWitness === 'true' || false
            }
        });
    } catch (err) {
        logger.error('Error fetching accounts count:', err);
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
        }
        let accountFromDB: any = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        if (!accountFromDB) {
            // If not found by ObjectId, perhaps try by name if that's a fallback?
            accountFromDB = await mongo.getDb().collection('accounts').findOne({ name: req.params.name });
            if (!accountFromDB) {
                 return res.status(404).json({ success: false, error: 'Account not found by ID or name.' });
            }
        }

        const { _id, totalVoteWeight, balances, ...rest } = accountFromDB;
        const account: any = { ...rest };
        if (_id) {
            account.id = _id.toString();
        }
        if (totalVoteWeight) {
            account.totalVoteWeight = toBigInt(totalVoteWeight as string).toString();
        }
        if (balances) {
            // Format token balances with proper decimals
            account.balances = formatTokenBalancesForResponse(balances);
        }

        res.json({ success: true, account });
    } catch (err) {
        logger.error(`Error fetching account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

// GET /accounts/:name/transactions - Get transaction history for an account
router.get('/:name/transactions', async (req: Request, res: Response) => {
    const { name } = req.params;
    const { limit, skip } = getPagination(req);
    const { type, dataKey, dataValue } = req.query;

    try {
        const query: any = {
            $or: [
                { sender: name },
                { 'data.recipient': name },
                { 'data.to': name }, 
                { 'data.owner': name },
                { 'data.creator': name },
                { 'data.issuer': name },
                { 'data.buyer': name },
                { 'data.seller': name },
                { 'data.provider': name } 
                // Add other relevant fields that might signify user involvement in a transaction
            ]
        };

        if (type) {
            query.type = parseInt(type as string);
        }
        if (dataKey && dataValue) {
            query[`data.${dataKey as string}`] = dataValue;
        }

        const transactionsFromDB = await mongo.getDb().collection('transactions')
            .find(query)
            .sort({ ts: -1 })
            .limit(limit)
            .skip(skip)
            .toArray();
        
        const total = await mongo.getDb().collection('transactions').countDocuments(query);

        const transactions = transactionsFromDB.map((tx: any) => {
            const { _id, ...restOfTx } = tx;
            return {
                ...restOfTx,
                id: _id.toString(), // Transform _id to id
                data: transformTransactionData(tx.data) // Use shared helper
            };
        });

        res.json({
            data: transactions,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching transactions for account ${name}:`, error);
        res.status(500).json({ message: 'Error fetching transactions for account', error: error.message });
    }
});

// GET /accounts/:name/tokens - Get all tokens held by an account
router.get('/:name/tokens', (async (req: Request, res: Response) => {
    try {
        const accountName = req.params.name;
        let accountFromDB: any; // Use any for now, or define a proper DB type
        try {
            const accountId = new ObjectId(accountName);
            accountFromDB = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        } catch (e) {
            accountFromDB = await mongo.getDb().collection('accounts').findOne({ name: accountName });
        }
        
        if (!accountFromDB) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        
        const balances = accountFromDB.balances || {}; // Assuming balances field, not tokens
        
        const tokenBalances = Object.entries(balances).map(([symbol, amount]) => {
            const formattedBalance = formatTokenBalancesForResponse({ [symbol]: amount as string | bigint | number });
            return {
                symbol,
                ...formattedBalance[symbol]
            };
        });
        
        res.json({ success: true, data: tokenBalances });
    } catch (err) {
        logger.error(`Error fetching tokens for account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);




export default router; 