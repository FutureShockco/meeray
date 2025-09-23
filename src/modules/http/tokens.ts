import express, { Request, RequestHandler, Response, Router } from 'express';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { mongo } from '../../mongo.js';
import { TokenData } from '../../transactions/token/token-interfaces.js';
import { formatTokenAmountForResponse } from '../../utils/http.js';
import { getPagination } from './utils.js';

const router: Router = express.Router();

// --- Tokens ---

/**
 * @api {get} /tokens Get all tokens
 * @apiName GetTokens
 * @apiGroup Tokens
 * @apiDescription Retrieve a paginated list of all registered tokens
 *
 * @apiUse PaginationParams
 *
 * @apiSuccess {Object[]} data List of tokens
 * @apiSuccess {String} data.symbol Token symbol
 * @apiSuccess {String} data.name Token name
 * @apiSuccess {Number} data.decimals Token decimals
 * @apiSuccess {String} data.supply Total supply
 * @apiSuccess {String} data.issuer Token issuer
 *
 * @apiError {String} error Error message
 */
// GET /tokens - List all registered tokens
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const mongoQuery = { symbol: { $not: /^LP_/ } };
        const tokensFromDB: TokenData[] | null = (await cache.findPromise('tokens', mongoQuery, {
            limit,
            skip,
            sort: { _id: 1 },
        })) as TokenData[] | null;
        const total = await mongo.getDb().collection('tokens').countDocuments(mongoQuery);

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: TokenData) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };
                // Format supply values with proper decimals
                if (maxSupply) {
                    const formattedSupply = formatTokenAmountForResponse(maxSupply, tokenDoc.symbol);
                    transformedToken.maxSupply = formattedSupply.amount;
                    transformedToken.rawMaxSupply = formattedSupply.rawAmount;
                }
                if (currentSupply) {
                    const formattedSupply = formatTokenAmountForResponse(currentSupply, tokenDoc.symbol);
                    transformedToken.currentSupply = formattedSupply.amount;
                    transformedToken.rawCurrentSupply = formattedSupply.rawAmount;
                }

                return transformedToken;
            });
        }

        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching tokens:', error);
        res.status(500).json({ message: 'Error fetching tokens', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/new - List newest tokens
router.get('/new', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const mongoQuery = { symbol: { $not: /^LP_/ } };
        const tokensFromDB: TokenData[] | null = (await cache.findPromise('tokens', mongoQuery, {
            limit,
            skip,
            sort: { createdAt: -1 },
        })) as TokenData[] | null;
        const total = await mongo.getDb().collection('tokens').countDocuments(mongoQuery);

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: TokenData) => {
                const { maxSupply, currentSupply, createdAt, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest, createdAt };

                // Format supply values with proper decimals
                if (maxSupply) {
                    const formattedSupply = formatTokenAmountForResponse(maxSupply, tokenDoc.symbol);
                    transformedToken.maxSupply = formattedSupply.amount;
                    transformedToken.rawMaxSupply = formattedSupply.rawAmount;
                }
                if (currentSupply) {
                    const formattedSupply = formatTokenAmountForResponse(currentSupply, tokenDoc.symbol);
                    transformedToken.currentSupply = formattedSupply.amount;
                    transformedToken.rawCurrentSupply = formattedSupply.rawAmount;
                }

                return transformedToken;
            });
        }

        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching new tokens:', error);
        res.status(500).json({ message: 'Error fetching new tokens', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/:symbol - Get a specific token by its symbol
router.get('/:symbol', (async (req: Request, res: Response) => {
    const { symbol } = req.params;
    try {
        const tokenFromDB = (await cache.findOnePromise('tokens', { _id: symbol })) as TokenData | null;
        if (!tokenFromDB) {
            return res.status(404).json({ message: `Token ${symbol} not found.` });
        }
        const { maxSupply, currentSupply, ...rest } = tokenFromDB;
        const token: any = { ...rest };

        // Format supply values with proper decimals
        if (maxSupply) {
            const formattedSupply = formatTokenAmountForResponse(maxSupply, symbol);
            token.maxSupply = formattedSupply.amount;
            token.rawMaxSupply = formattedSupply.rawAmount;
        }
        if (currentSupply) {
            const formattedSupply = formatTokenAmountForResponse(currentSupply, symbol);
            token.currentSupply = formattedSupply.amount;
            token.rawCurrentSupply = formattedSupply.rawAmount;
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
        const mongoQuery = { issuer: issuerName, symbol: { $not: /^LP_/ } };
        const tokensFromDB: TokenData[] | null = (await cache.findPromise('tokens', mongoQuery, {
            limit,
            skip,
            sort: { _id: 1 },
        })) as TokenData[] | null;
        const total = await mongo.getDb().collection('tokens').countDocuments(mongoQuery);

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: TokenData) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };

                // Format supply values with proper decimals
                if (maxSupply) {
                    const formattedSupply = formatTokenAmountForResponse(maxSupply, tokenDoc.symbol);
                    transformedToken.maxSupply = formattedSupply.amount;
                    transformedToken.rawMaxSupply = formattedSupply.rawAmount;
                }
                if (currentSupply) {
                    const formattedSupply = formatTokenAmountForResponse(currentSupply, tokenDoc.symbol);
                    transformedToken.currentSupply = formattedSupply.amount;
                    transformedToken.rawCurrentSupply = formattedSupply.rawAmount;
                }

                return transformedToken;
            });
        }
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
        const mongoQuery = { name: { $regex: searchName, $options: 'i' }, symbol: { $not: /^LP_/ } };
        const tokensFromDB: TokenData[] | null = (await cache.findPromise('tokens', mongoQuery, {
            limit,
            skip,
            sort: { _id: 1 },
        })) as TokenData[] | null;
        const total = await mongo.getDb().collection('tokens').countDocuments(mongoQuery);

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: TokenData) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };

                // Format supply values with proper decimals
                if (maxSupply) {
                    const formattedSupply = formatTokenAmountForResponse(maxSupply, tokenDoc.symbol);
                    transformedToken.maxSupply = formattedSupply.amount;
                    transformedToken.rawMaxSupply = formattedSupply.rawAmount;
                }
                if (currentSupply) {
                    const formattedSupply = formatTokenAmountForResponse(currentSupply, tokenDoc.symbol);
                    transformedToken.currentSupply = formattedSupply.amount;
                    transformedToken.rawCurrentSupply = formattedSupply.rawAmount;
                }

                return transformedToken;
            });
        }

        res.json({ data: tokens, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error searching tokens by name ${searchName}:`, error);
        res.status(500).json({ message: 'Error searching tokens by name', error: error.message });
    }
}) as RequestHandler);

// GET /tokens/hot - Placeholder for Hot Coins
router.get('/hot', (async (req: Request, res: Response) => {
    logger.info('[tokens/hot] Endpoint called. This is a placeholder and needs metrics for "hotness".');
    // TODO: Implement logic to determine "hot" coins.
    // This might involve:
    // - Tracking recent transaction volume (requires transaction logging with timestamps and token symbols).
    // - Monitoring social media mentions or trending scores (external data integration).
    // - Counting recent queries or views for specific tokens on your platform.
    res.status(501).json({ message: 'Endpoint not implemented: Hot coins determination logic needed.' });
}) as RequestHandler);

// GET /tokens/top-gainers - Placeholder for Top Gainers
router.get('/top-gainers', (async (req: Request, res: Response) => {
    logger.info('[tokens/top-gainers] Endpoint called. This is a placeholder and needs price history.');
    // TODO: Implement logic for Top Gainers.
    // This requires:
    // - Storing historical price data for tokens (e.g., daily/hourly snapshots).
    // - Calculating percentage price change over a defined period (e.g., last 24 hours).
    // - Accessing current price data.
    res.status(501).json({ message: 'Endpoint not implemented: Price history and calculation logic needed.' });
}) as RequestHandler);

// GET /tokens/top-volume - Placeholder for Top Volume
router.get('/top-volume', (async (req: Request, res: Response) => {
    logger.info('[tokens/top-volume] Endpoint called. This is a placeholder and needs volume tracking.');
    // TODO: Implement logic for Top Volume.
    // This requires:
    // - Logging transaction volume for each token (e.g., sum of amounts in transfers/trades).
    // - Aggregating this volume over a specific period (e.g., 24-hour rolling volume).
    res.status(501).json({ message: 'Endpoint not implemented: Transaction volume tracking and aggregation needed.' });
}) as RequestHandler);

export default router;
