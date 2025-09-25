import express, { Request, RequestHandler, Response, Router } from 'express';
import { ObjectId } from 'mongodb';

import logger from '../../logger.js';
import mongo from '../../mongo.js';
import { toBigInt } from '../../utils/bigint.js';
import { formatTokenBalancesForResponse, transformTransactionData } from '../../utils/http.js';
import { getPagination } from './utils.js';

const router: Router = express.Router();

/**
 * @api {get} /accounts Get all accounts
 * @apiName GetAccounts
 * @apiGroup Accounts
 * @apiDescription Retrieve a paginated list of all accounts with optional filtering
 *
 * @apiUse PaginationParams
 *
 * @apiParam {String} [hasToken] Filter accounts that have a specific token
 * @apiParam {Boolean} [isWitness] Filter accounts that are witnesses
 * @apiParam {String} [sortBy=name] Field to sort by
 * @apiParam {String} [sortDirection=asc] Sort direction (asc or desc)
 *
 * @apiSuccess {Object[]} data List of accounts
 * @apiSuccess {String} data.name Account name
 * @apiSuccess {String} data.balance Account balance
 * @apiSuccess {Object[]} data.tokens Account tokens
 *
 * @apiError {String} error Error message
 * @apiError {Number} code Error code
 */
router.get('/', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        const query: any = {};
        if (req.query.hasToken) {
            const tokenSymbol = req.query.hasToken as string;
            query[`balances.${tokenSymbol}`] = { $exists: true, $ne: '0' };
        }
        if (req.query.isWitness === 'true') {
            query.witnessPublicKey = { $exists: true, $ne: '' };
        }
        const sortField = (req.query.sortBy as string) || 'name';
        const sortDirection = req.query.sortDirection === 'desc' ? -1 : 1;
        const sort: any = {};
        sort[sortField] = sortDirection;
        const accountsFromDB: any[] = await mongo.getDb().collection('accounts').find(query).sort(sort).limit(limit).skip(skip).toArray();
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
                transformedAcc.balances = formatTokenBalancesForResponse(balances);
            }
            return transformedAcc;
        });
        res.json({ success: true, data: accounts, total, limit, skip, page: Math.floor(skip / limit) + 1 });
    } catch (err) {
        logger.error('Error fetching accounts list:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /accounts/count Get accounts count
 * @apiName GetAccountsCount
 * @apiGroup Accounts
 * @apiDescription Get the total number of accounts with optional filtering
 *
 * @apiParam {String} [hasToken] Filter accounts that have a specific token
 * @apiParam {Boolean} [isWitness] Filter accounts that are witnesses
 *
 * @apiSuccess {Boolean} success Success status
 * @apiSuccess {Number} count Total number of accounts
 * @apiSuccess {Object} filters Applied filters
 * @apiSuccess {String} filters.hasToken Token filter applied
 * @apiSuccess {Boolean} filters.isWitness Witness filter applied
 *
 * @apiError {String} error Error message
 */
router.get('/count', (async (req: Request, res: Response) => {
    try {
        const query: any = {};
        if (req.query.hasToken) {
            const tokenSymbol = req.query.hasToken as string;
            query[`balances.${tokenSymbol}`] = { $exists: true, $ne: '0' };
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
                isWitness: req.query.isWitness === 'true',
            },
        });
    } catch (err) {
        logger.error('Error fetching accounts count:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /accounts/:name Get account details
 * @apiName GetAccount
 * @apiGroup Accounts
 * @apiDescription Retrieve detailed information about a specific account
 *
 * @apiParam {String} name Account name or ID
 *
 * @apiSuccess {Boolean} success Success status
 * @apiSuccess {Object} account Account details
 * @apiSuccess {String} account.name Account name
 * @apiSuccess {String} account.id Account ID
 * @apiSuccess {String} account.totalVoteWeight Total vote weight
 * @apiSuccess {Object} account.balances Token balances
 *
 * @apiError {String} error Error message
 */
router.get('/:name', (async (req: Request, res: Response) => {
    try {
        if (!req.params.name || typeof req.params.name !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid account name format.' });
        }
        let accountId;
        try {
            accountId = new ObjectId(req.params.name);
        } catch {
            // Ignore error, will try by name instead
        }
        let accountFromDB: any = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        if (!accountFromDB) {
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
            account.balances = formatTokenBalancesForResponse(balances);
        }
        res.json({ success: true, account });
    } catch (err) {
        logger.error(`Error fetching account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /accounts/:name/transactions Get account transactions
 * @apiName GetAccountTransactions
 * @apiGroup Accounts
 * @apiDescription Retrieve a paginated list of transactions for a specific account
 *
 * @apiParam {String} name Account name or ID
 *
 * @apiUse PaginationParams
 *
 * @apiParam {Number} [type] Filter by transaction type
 * @apiParam {String} [dataKey] Filter by data field key
 * @apiParam {String} [dataValue] Filter by data field value
 *
 * @apiSuccess {Object[]} data List of transactions
 * @apiSuccess {String} data.id Transaction ID
 * @apiSuccess {String} data.sender Transaction sender
 * @apiSuccess {Number} data.type Transaction type
 * @apiSuccess {Object} data.data Transaction data
 * @apiSuccess {Number} data.ts Transaction timestamp
 *
 * @apiError {String} error Error message
 */
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
                { 'data.user': name },
            ],
        };
        if (type) {
            query.type = parseInt(type as string);
        }
        if (dataKey && dataValue) {
            query[`data.${dataKey as string}`] = dataValue;
        }
        const transactionsFromDB = await mongo.getDb().collection('transactions').find(query).sort({ ts: -1 }).limit(limit).skip(skip).toArray();
        const total = await mongo.getDb().collection('transactions').countDocuments(query);
        const transactions = transactionsFromDB.map((tx: any) => {
            const { _id, ...restOfTx } = tx;
            return {
                ...restOfTx,
                id: _id.toString(), // Transform _id to id
                data: transformTransactionData(tx.data), // Use shared helper
            };
        });
        res.json({
            data: transactions,
            total,
            limit,
            skip,
            page: Math.floor(skip / limit) + 1,
        });
    } catch (error: any) {
        logger.error(`Error fetching transactions for account ${name}:`, error);
        res.status(500).json({ message: 'Error fetching transactions for account', error: error.message });
    }
});

/**
 * @api {get} /accounts/:name/tokens Get account tokens
 * @apiName GetAccountTokens
 * @apiGroup Accounts
 * @apiDescription Retrieve all token balances for a specific account
 *
 * @apiParam {String} name Account name or ID
 *
 * @apiSuccess {Object[]} data List of token balances
 * @apiSuccess {String} data.symbol Token symbol
 * @apiSuccess {String} data.amount Formatted token amount
 * @apiSuccess {String} data.rawAmount Raw token amount
 *
 * @apiError {String} error Error message
 */
router.get('/:name/tokens', (async (req: Request, res: Response) => {
    try {
        const accountName = req.params.name;
        let accountFromDB: any; // Use any for now, or define a proper DB type
        try {
            const accountId = new ObjectId(accountName);
            accountFromDB = await mongo.getDb().collection('accounts').findOne({ _id: accountId });
        } catch {
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
                ...formattedBalance[symbol],
            };
        });
        res.json({ success: true, data: tokenBalances });
    } catch (err) {
        logger.error(`Error fetching tokens for account ${req.params.name}:`, err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

export default router;
