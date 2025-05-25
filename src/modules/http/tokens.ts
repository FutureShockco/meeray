import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint-utils.js';

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
        const tokensFromDB: any[] | null = await cache.findPromise('tokens', {}, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tokens').countDocuments({});
        
        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: any) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };
                if (maxSupply) {
                    transformedToken.maxSupply = toBigInt(maxSupply as string).toString();
                }
                if (currentSupply) {
                    transformedToken.currentSupply = toBigInt(currentSupply as string).toString();
                }
                // _id in tokens collection is the symbol (string), so no transformation needed for _id itself
                return transformedToken;
            });
        }

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
        const tokenFromDB = await cache.findOnePromise('tokens', { _id: symbol });
        if (!tokenFromDB) {
            return res.status(404).json({ message: `Token ${symbol} not found.` });
        }
        const { maxSupply, currentSupply, ...rest } = tokenFromDB as any;
        const token: any = { ...rest };
        if (maxSupply) {
            token.maxSupply = toBigInt(maxSupply as string).toString();
        }
        if (currentSupply) {
            token.currentSupply = toBigInt(currentSupply as string).toString();
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
        const tokensFromDB: any[] | null = await cache.findPromise('tokens', { issuer: issuerName }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tokens').countDocuments({ issuer: issuerName });

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: any) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };
                if (maxSupply) {
                    transformedToken.maxSupply = toBigInt(maxSupply as string).toString();
                }
                if (currentSupply) {
                    transformedToken.currentSupply = toBigInt(currentSupply as string).toString();
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
        const query = { name: { $regex: searchName, $options: 'i' } };
        const tokensFromDB: any[] | null = await cache.findPromise('tokens', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('tokens').countDocuments(query);

        let tokens: any[] = [];
        if (tokensFromDB && tokensFromDB.length > 0) {
            tokens = tokensFromDB.map((tokenDoc: any) => {
                const { maxSupply, currentSupply, ...rest } = tokenDoc;
                const transformedToken: any = { ...rest };
                if (maxSupply) {
                    transformedToken.maxSupply = toBigInt(maxSupply as string).toString();
                }
                if (currentSupply) {
                    transformedToken.currentSupply = toBigInt(currentSupply as string).toString();
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

export default router; 