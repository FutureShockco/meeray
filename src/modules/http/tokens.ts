import express, { Request, RequestHandler, Response, Router } from 'express';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { mongo } from '../../mongo.js';
import { TokenData } from '../../transactions/token/token-interfaces.js';
import { formatTokenAmountForResponse } from '../../utils/http.js';
import { getPagination } from './utils.js';
import { toBigInt, formatTokenAmount } from '../../utils/bigint.js';
import tokenCache from '../../utils/tokenCache.js';

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
            // Preload tokens into cache for other endpoints
            tokenCache.preloadAll(tokensFromDB as any[]);
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


router.get('/hot', (async (req: Request, res: Response) => {
    const { limit = 10, skip = 0 } = getPagination(req);
    try {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        // Retrieve recent trades in the last 24h (cap to avoid excessive memory usage)
        const recentTrades: any[] = await mongo.getDb().collection('trades')
            .find({ timestamp: { $gt: new Date(oneDayAgo).toISOString() } })
            .sort({ timestamp: -1 })
            .limit(20000)
            .toArray();
        // Aggregate stats by base token symbol
        const stats = new Map<string, { tradeCount: number; volume: bigint; latestPrice?: bigint; quote?: string }>();

        for (const tr of recentTrades) {
            const symbol = tr.baseAssetSymbol || tr.baseSymbol || tr.token || tr.symbol;
            if (!symbol) continue;
            const vol = tr.volume ? toBigInt(tr.volume) : tr.total ? toBigInt(tr.total) : 0n;
            const price = tr.price ? toBigInt(tr.price) : 0n;

            const cur = stats.get(symbol) || { tradeCount: 0, volume: 0n, latestPrice: undefined, quote: tr.quoteAssetSymbol };
            cur.tradeCount += 1;
            cur.volume = cur.volume + vol;
            if (!cur.latestPrice && price) cur.latestPrice = price;
            stats.set(symbol, cur);
        }

        // Build response sorted by tradeCount then volume
        const tokensHot = Array.from(stats.entries()).map(([symbol, s]) => {
            const quote = s.quote || symbol;
            return {
                symbol,
                tradeCount24h: s.tradeCount,
                rawVolume24h: s.volume.toString(),
                latestPrice: s.latestPrice ? formatTokenAmount(s.latestPrice, quote) : undefined,
                rawLatestPrice: s.latestPrice ? s.latestPrice.toString() : undefined,
            };
        })
            .sort((a, b) => b.tradeCount24h - a.tradeCount24h || (toBigInt(b.rawVolume24h) > toBigInt(a.rawVolume24h) ? 1 : -1))
            .slice(skip, skip + limit);

        res.json({ data: tokensHot, total: tokensHot.length, limit, skip });
    } catch (error: any) {
        logger.error('[tokens/hot] Error computing hot tokens:', error);
        res.status(500).json({ message: 'Error computing hot tokens', error: error.message });
    }
}) as RequestHandler);


router.get('/top-gainers', (async (req: Request, res: Response) => {
    const { limit = 10, skip = 0 } = getPagination(req);
    try {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        // Fetch recent trades in last 24h (sorted newest first)
        const recentTrades: any[] = await mongo.getDb().collection('trades')
            .find({ timestamp: { $gt: new Date(oneDayAgo).toISOString() } })
            .sort({ timestamp: -1 })
            .limit(20000)
            .toArray();

        const map = new Map<string, { latestPrice?: bigint; oldestPrice?: bigint; latestQuote?: string; tradeCount: number; volume: bigint }>();

        for (const tr of recentTrades) {
            const symbol = tr.baseAssetSymbol || tr.baseSymbol || tr.token || tr.symbol;
            if (!symbol) continue;
            const price = tr.price ? toBigInt(tr.price) : 0n;
            const vol = tr.volume ? toBigInt(tr.volume) : tr.total ? toBigInt(tr.total) : 0n;

            const cur = map.get(symbol) || { latestPrice: undefined, oldestPrice: undefined, latestQuote: tr.quoteAssetSymbol, tradeCount: 0, volume: 0n };
            if (!cur.latestPrice && price) cur.latestPrice = price;
            // Because recentTrades are newest-first, setting oldestPrice to price on each iteration results in oldestPrice being the last seen (oldest)
            if (price) cur.oldestPrice = price;
            cur.tradeCount += 1;
            cur.volume = cur.volume + vol;
            map.set(symbol, cur);
        }

        const results = Array.from(map.entries()).map(([symbol, s]) => {
            let priceChangeBig = 0n;
            let priceChangePercent = 0;
            if (s.latestPrice && s.oldestPrice && s.oldestPrice > 0n) {
                priceChangeBig = s.latestPrice - s.oldestPrice;
                priceChangePercent = (Number(priceChangeBig) / Number(s.oldestPrice)) * 100;
            }
            const quote = s.latestQuote || symbol;
            return {
                symbol,
                tradeCount24h: s.tradeCount,
                rawVolume24h: s.volume.toString(),
                priceChange24h: formatTokenAmount(priceChangeBig, quote),
                rawPriceChange24h: priceChangeBig.toString(),
                priceChange24hPercent: priceChangePercent,
                latestPrice: s.latestPrice ? formatTokenAmount(s.latestPrice, quote) : undefined,
                rawLatestPrice: s.latestPrice ? s.latestPrice.toString() : undefined,
            };
        });

        const sorted = results.sort((a, b) => b.priceChange24hPercent - a.priceChange24hPercent).slice(skip, skip + limit);
        res.json({ data: sorted, total: results.length, limit, skip });
    } catch (error: any) {
        logger.error('[tokens/top-gainers] Error computing top gainers:', error);
        res.status(500).json({ message: 'Error computing top gainers', error: error.message });
    }
}) as RequestHandler);


router.get('/top-volume', (async (req: Request, res: Response) => {
    const { limit = 10, skip = 0 } = getPagination(req);
    try {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        // Retrieve recent trades in the last 24h (cap increased for volume calculations)
        const recentTrades: any[] = await mongo.getDb().collection('trades')
            .find({ timestamp: { $gt: new Date(oneDayAgo).toISOString() } })
            .sort({ timestamp: -1 })
            .limit(50000)
            .toArray();
        const map = new Map<string, { tradeCount: number; volume: bigint; quote?: string }>();
        for (const tr of recentTrades) {
            const symbol = tr.baseAssetSymbol || tr.baseSymbol || tr.token || tr.symbol;
            if (!symbol) continue;
            const vol = tr.volume ? toBigInt(tr.volume) : tr.total ? toBigInt(tr.total) : 0n;
            const cur = map.get(symbol) || { tradeCount: 0, volume: 0n, quote: tr.quoteAssetSymbol };
            cur.tradeCount += 1;
            cur.volume = cur.volume + vol;
            map.set(symbol, cur);
        }

        const results = Array.from(map.entries())
            .map(([symbol, s]) => {
                const quote = s.quote || symbol;
                return {
                    symbol,
                    tradeCount24h: s.tradeCount,
                    rawVolume24h: s.volume.toString(),
                    volume24h: formatTokenAmount(s.volume, quote),
                };
            })
            .sort((a, b) => (toBigInt(b.rawVolume24h) > toBigInt(a.rawVolume24h) ? 1 : -1))
            .slice(skip, skip + limit);

        res.json({ data: results, total: results.length, limit, skip });
    } catch (error: any) {
        logger.error('[tokens/top-volume] Error computing top volume tokens:', error);
        res.status(500).json({ message: 'Error computing top volume tokens', error: error.message });
    }
}) as RequestHandler);


router.get('/:symbol', (async (req: Request, res: Response) => {
    const { symbol } = req.params;
    try {
        // Try token cache first
        let tokenFromDB: TokenData | null = await tokenCache.getToken(symbol) as TokenData | null;
        if (!tokenFromDB) {
            tokenFromDB = (await cache.findOnePromise('tokens', { _id: symbol })) as TokenData | null;
            if (tokenFromDB) tokenCache.setToken(symbol, tokenFromDB as any);
        }
        if (!tokenFromDB) {
            return res.status(404).json({ message: `Token ${symbol} not found.` });
        }
        const { maxSupply, currentSupply, ...rest } = tokenFromDB;
        const token: any = { ...rest };
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

export default router;
