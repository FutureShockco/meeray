import express, { Request, RequestHandler, Response } from 'express';

import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { liquidityAggregator } from '../../transactions/market/market-aggregator.js';
import { HybridTradeData } from '../../transactions/market/market-interfaces.js';
import { calculateTradeValue, formatTokenAmount, getTokenDecimals, toBigInt } from '../../utils/bigint.js';

const router = express.Router();

/**
 * Get all available liquidity sources for a token pair
 * GET /hybrid/sources/:tokenA/:tokenB
 */
router.get('/sources/:tokenA/:tokenB', (async (req: Request, res: Response) => {
    try {
        const { tokenA, tokenB } = req.params;

        if (!tokenA || !tokenB) {
            return res.status(400).json({
                message: 'Both tokenA and tokenB are required',
            });
        }

        const sources = await liquidityAggregator.getLiquiditySources(tokenA, tokenB);

        // Transform for API response
        const transformedSources = sources.map(source => ({
            type: source.type,
            id: source.id,
            tokenA: source.tokenA,
            tokenB: source.tokenB,
            ...(source.type === 'AMM' && {
                reserveA: formatAmount(toBigInt(source.reserveA!), source.tokenA),
                reserveB: formatAmount(toBigInt(source.reserveB!), source.tokenB),
                rawReserveA: source.reserveA?.toString(),
                rawReserveB: source.reserveB?.toString(),
            }),
            ...(source.type === 'ORDERBOOK' && {
                bestBid: formatAmount(toBigInt(source.bestBid!)),
                bestAsk: formatAmount(toBigInt(source.bestAsk!)),
                rawBestBid: source.bestBid?.toString(),
                rawBestAsk: source.bestAsk?.toString(),
                bidDepth: formatAmount(toBigInt(source.bidDepth!), source.tokenA),
                askDepth: formatAmount(toBigInt(source.askDepth!), source.tokenA),
                rawBidDepth: source.bidDepth?.toString(),
                rawAskDepth: source.askDepth?.toString(),
            }),
        }));

        res.json({
            tokenA,
            tokenB,
            sources: transformedSources,
            totalSources: sources.length,
            ammSources: sources.filter(s => s.type === 'AMM').length,
            orderbookSources: sources.filter(s => s.type === 'ORDERBOOK').length,
        });
    } catch (error: any) {
        logger.error('Error fetching liquidity sources:', error);
        res.status(500).json({
            message: 'Error fetching liquidity sources',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get optimal hybrid trade quote
 * POST /hybrid/quote
 */
router.post('/quote', (async (req: Request, res: Response) => {
    try {
        const { tokenIn, tokenOut, amountIn, maxSlippagePercent } = req.body;

        if (!tokenIn || !tokenOut || !amountIn) {
            return res.status(400).json({
                message: 'tokenIn, tokenOut, and amountIn are required',
            });
        }

        // Validate amountIn
        let amountInBigInt: bigint;
        try {
            amountInBigInt = toBigInt(amountIn);
            if (amountInBigInt <= toBigInt(0)) {
                throw new Error('Amount must be positive');
            }
        } catch {
            return res.status(400).json({
                message: 'Invalid amountIn: must be a positive number',
            });
        }

        const tradeData: HybridTradeData = {
            tokenIn,
            tokenOut,
            amountIn: amountInBigInt,
            maxSlippagePercent,
        };

        const quote = await liquidityAggregator.getBestQuote(tradeData);

        if (!quote) {
            return res.status(404).json({
                message: 'No liquidity available for this trade pair',
            });
        }

        // Add formatted amounts and additional info
        const enhancedQuote = {
            ...quote,
            amountIn: formatAmount(toBigInt(quote.amountIn), tokenIn),
            rawAmountIn: quote.amountIn,
            routes: quote.routes.map(route => ({
                ...route,
                amountIn: formatAmount(toBigInt(route.amountIn), tokenIn),
                amountOut: formatAmount(toBigInt(route.amountOut), tokenOut),
                rawAmountIn: route.amountIn,
                rawAmountOut: route.amountOut,
                details: route.details,
            })),
            recommendation: getBestRouteRecommendation(quote),
        };

        res.json(enhancedQuote);
    } catch (error: any) {
        logger.error('Error getting hybrid quote:', error);
        res.status(500).json({
            message: 'Error getting trade quote',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Compare AMM vs Orderbook for a specific trade
 * POST /hybrid/compare
 */
router.post('/compare', (async (req: Request, res: Response) => {
    try {
        const { tokenIn, tokenOut, amountIn } = req.body;

        if (!tokenIn || !tokenOut || !amountIn) {
            return res.status(400).json({
                message: 'tokenIn, tokenOut, and amountIn are required',
            });
        }

        // const tradeData: HybridTradeData = {
        //     tokenIn,
        //     tokenOut,
        //     amountIn: toBigInt(amountIn),
        // };

        // Get all sources
        const sources = await liquidityAggregator.getLiquiditySources(tokenIn, tokenOut);

        // Separate AMM and orderbook sources
        const ammSources = sources.filter(s => s.type === 'AMM');
        const orderbookSources = sources.filter(s => s.type === 'ORDERBOOK');

        // Get quotes for each type
        const comparison = {
            amm: {
                available: ammSources.length > 0,
                sources: ammSources.length,
                bestQuote: null as any,
                totalLiquidity: ammSources.reduce((sum, s) => sum + Number(s.reserveA || 0) + Number(s.reserveB || 0), 0),
            },
            orderbook: {
                available: orderbookSources.length > 0,
                sources: orderbookSources.length,
                bestQuote: null as any,
                totalDepth: orderbookSources.reduce((sum, s) => sum + Number(s.bidDepth || 0) + Number(s.askDepth || 0), 0),
            },
            recommendation: 'HYBRID' as 'AMM' | 'ORDERBOOK' | 'HYBRID',
        };

        // This would be enhanced with actual quote calculations
        // For now, returning structure

        res.json({
            tokenIn,
            tokenOut,
            amountIn: formatAmount(toBigInt(amountIn), tokenIn),
            rawAmountIn: amountIn,
            comparison,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        logger.error('Error comparing liquidity sources:', error);
        res.status(500).json({
            message: 'Error comparing liquidity sources',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get statistics for a specific trading pair
 * GET /market/stats/:pairId
 */
router.get('/stats/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;

        // Check if trading pair exists
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            return res.status(404).json({ message: 'Trading pair not found' });
        }

        // Determine requested period (hour, day, week, month, alltime)
        const period = (req.query.period as string) || 'day';

        // Helper to compute start timestamp (ms) for a period
        function periodStart(periodName: string): number {
            const now = Date.now();
            switch ((periodName || '').toLowerCase()) {
                case 'hour':
                    return now - 60 * 60 * 1000;
                case 'day':
                    return now - 24 * 60 * 60 * 1000;
                case 'week':
                    return now - 7 * 24 * 60 * 60 * 1000;
                case 'month':
                    // approx 30 days
                    return now - 30 * 24 * 60 * 60 * 1000;
                case 'alltime':
                    return 0;
                default:
                    return now - 24 * 60 * 60 * 1000;
            }
        }

        const startMs = periodStart(period);

        // For small ranges (hour/day/week) we'll fetch trades directly and aggregate in JS for accuracy.
        // For month and alltime we'll use a DB aggregation pipeline for efficiency.

        let trades: any[] = [];
        const smallRange = ['hour', 'day', 'week'].includes(period.toLowerCase());
        if (smallRange) {
            // Some deployments store trade.timestamp as strings or padded DB strings; avoid relying on DB range filters here.
            trades = (await cache.findPromise('trades', { pairId }, { sort: { timestamp: -1 }, limit: 10000 })) || [];
        } else {
            // Use MongoDB aggregation to compute summary and also fetch a limited page of recent trades
            const db = mongo.getDb();
            try {
                const match: any = {
                    pairId,
                    $or: [
                        { timestamp: { $gte: startMs } },
                        { timestamp: { $gte: new Date(startMs).toISOString() } },
                    ],
                };

                // Fetch recent page for display (not all items)
                const recentCursor = db.collection('trades').find(match).sort({ timestamp: -1 }).limit(100);
                trades = await recentCursor.toArray();
            } catch (err) {
                logger.error('Error running DB aggregation for stats fallback:', err);
                trades = (await cache.findPromise('trades', { pairId }, { sort: { timestamp: -1 }, limit: 100 })) || [];
            }
        }

        // Normalize trades: ensure numeric timestamp, and normalize price/quantity/volume fields
        const normalizedTrades = trades.map(trade => {
            let ts = 0;
            if (typeof trade.timestamp === 'number') ts = trade.timestamp;
            else if (typeof trade.timestamp === 'string') {
                const parsed = Date.parse(trade.timestamp);
                ts = Number.isNaN(parsed) ? 0 : parsed;
            } else if (trade.timestamp instanceof Date) ts = trade.timestamp.getTime();
            return {
                ...trade,
                timestamp: ts,
                price: trade.price || '0',
                quantity: trade.quantity || '0',
                volume: trade.volume || '0',
            };
        });

        const recentTrades = normalizedTrades.filter(trade => trade.timestamp > startMs);

        // Sum as bigint in smallest units
        const volumeForPeriod = recentTrades.reduce((sum, trade) => sum + toBigInt(trade.volume || 0), 0n);
        const tradeCountForPeriod = recentTrades.length;

        // Get price statistics
        // Compute price change over 24h using BigInt arithmetic to avoid Number overflow
        let priceChangeBig = 0n;
        let priceChangePercent = 0;
        if (recentTrades.length > 0) {
            const latestPriceBig = toBigInt(recentTrades[0]?.price || 0);
            const oldestPriceBig = toBigInt(recentTrades[recentTrades.length - 1]?.price || 0);
            if (oldestPriceBig > 0n) {
                priceChangeBig = latestPriceBig - oldestPriceBig;
                priceChangePercent = (Number(priceChangeBig) / Number(oldestPriceBig)) * 100;
            }
        }

        // Get current orders for this pair
        const orders = (await cache.findPromise('orders', { pairId }, { sort: { timestamp: -1 } })) || [];
        const buyOrders = orders.filter(order => order.side === 'BUY' && (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED'));
        const sellOrders = orders.filter(order => order.side === 'SELL' && (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED'));

        // Calculate spread using BigInt-safe comparisons
        const highestBidBig =
            buyOrders.length > 0
                ? buyOrders.reduce((m, order) => {
                    const p = toBigInt(order.price || 0);
                    return p > m ? p : m;
                }, 0n)
                : 0n;
        const lowestAskBig =
            sellOrders.length > 0
                ? sellOrders.reduce((m, order) => {
                    const p = toBigInt(order.price || 0);
                    return m === 0n || p < m ? p : m;
                }, 0n)
                : 0n;
        const spreadBig = lowestAskBig > 0n && highestBidBig > 0n ? lowestAskBig - highestBidBig : 0n;
        const spreadPercentValue = highestBidBig > 0n ? (Number(spreadBig) / Number(highestBidBig)) * 100 : 0;
        res.json({
            pairId,
            pair,
            period,
            volume: formatAmount(volumeForPeriod, pair.quoteAssetSymbol),
            rawVolume: volumeForPeriod.toString(),
            tradeCount: tradeCountForPeriod,
            priceChange: formatAmount(priceChangeBig, pair.quoteAssetSymbol),
            rawPriceChange: priceChangeBig.toString(),
            priceChangePercent,
            currentPrice: recentTrades[0] ? formatAmount(toBigInt(recentTrades[0].price || 0), pair.quoteAssetSymbol) : '0.00000000',
            rawCurrentPrice: recentTrades[0] ? toBigInt(recentTrades[0].price || 0).toString() : '0',
            highestBid: formatAmount(highestBidBig, pair.quoteAssetSymbol),
            rawHighestBid: highestBidBig.toString(),
            lowestAsk: formatAmount(lowestAskBig, pair.quoteAssetSymbol),
            rawLowestAsk: lowestAskBig.toString(),
            spread: formatAmount(spreadBig, pair.quoteAssetSymbol),
            rawSpread: spreadBig.toString(),
            spreadPercent: spreadPercentValue,
            buyOrderCount: buyOrders.length,
            sellOrderCount: sellOrders.length,
            recentTrades: normalizedTrades.slice(0, 10).map(trade => ({
                ...trade,
                price: formatAmount(toBigInt(trade.price || 0), pair.quoteAssetSymbol),
                rawPrice: toBigInt(trade.price || 0).toString(),
                quantity: formatAmount(toBigInt(trade.quantity || 0), pair.baseAssetSymbol),
                rawQuantity: toBigInt(trade.quantity || 0).toString(),
                volume: trade.volume ? formatAmount(toBigInt(trade.volume), pair.quoteAssetSymbol) : '0.00000000',
                rawVolume: trade.volume ? toBigInt(trade.volume).toString() : '0',
            })),
        });
    } catch (error: any) {
        logger.error('Error fetching pair stats:', error);
        res.status(500).json({
            message: 'Error fetching pair stats',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get orderbook for a specific trading pair
 * GET /market/orderbook/:pairId
 */
router.get('/orderbook/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;
        const { depth = 20 } = req.query; // Default to 20 levels

        // Check if trading pair exists
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            return res.status(404).json({ message: 'Trading pair not found' });
        }

        // Get active orders for this pair
        const orders =
            (await cache.findPromise('orders', {
                pairId,
                status: { $in: ['OPEN', 'PARTIALLY_FILLED'] },
            })) || [];

        // Separate buy and sell orders
        const buyOrders = orders
            .filter(order => order.side === 'BUY')
            .sort((a, b) => Number(toBigInt(b.price || 0)) - Number(toBigInt(a.price || 0))) // Highest price first
            .slice(0, Number(depth));

        const sellOrders = orders
            .filter(order => order.side === 'SELL')
            .sort((a, b) => Number(toBigInt(a.price || 0)) - Number(toBigInt(b.price || 0))) // Lowest price first
            .slice(0, Number(depth));
        // Format orderbook data
        const bids = buyOrders.map(order => {
            const price = formatAmount(toBigInt(order.price || 0), pair.quoteAssetSymbol);
            const quantity = formatAmount(toBigInt(order.remainingQuantity || order.quantity), pair.baseAssetSymbol);
            const rawPrice = toBigInt(order.price || 0).toString();
            const rawQuantity = toBigInt(order.remainingQuantity || order.quantity).toString();

            // Calculate total considering decimal differences
            const rawTotalBigInt = calculateTradeValue(
                toBigInt(order.price || 0),
                toBigInt(order.remainingQuantity || order.quantity),
                pair.baseAssetSymbol,
                pair.quoteAssetSymbol
            );

            const total = formatAmount(rawTotalBigInt, pair.quoteAssetSymbol);
            const rawTotal = rawTotalBigInt.toString();

            return {
                price,
                rawPrice,
                quantity,
                rawQuantity,
                total,
                rawTotal,
            };
        });

        const asks = sellOrders.map(order => {
            const price = formatAmount(toBigInt(order.price || 0), pair.quoteAssetSymbol);
            const quantity = formatAmount(toBigInt(order.remainingQuantity || order.quantity), pair.baseAssetSymbol);
            const rawPrice = toBigInt(order.price || 0).toString();
            const rawQuantity = toBigInt(order.remainingQuantity || order.quantity).toString();

            // Calculate total considering decimal differences
            const rawTotalBigInt = calculateTradeValue(
                toBigInt(order.price || 0),
                toBigInt(order.remainingQuantity || order.quantity),
                pair.baseAssetSymbol,
                pair.quoteAssetSymbol
            );

            const total = formatAmount(rawTotalBigInt, pair.quoteAssetSymbol);
            const rawTotal = rawTotalBigInt.toString();

            return {
                price,
                rawPrice,
                quantity,
                rawQuantity,
                total,
                rawTotal,
            };
        });

        // Calculate spread using BigInt from rawPrice to avoid float rounding issues
        const highestBidBig = bids.length > 0 ? BigInt(bids[0].rawPrice) : 0n;
        const lowestAskBig = asks.length > 0 ? BigInt(asks[0].rawPrice) : 0n;
        const spreadBig = lowestAskBig > 0n && highestBidBig > 0n ? lowestAskBig - highestBidBig : 0n;
        const spreadPercent = highestBidBig > 0n ? (Number(spreadBig) / Number(highestBidBig)) * 100 : 0;
        const midPriceBig = highestBidBig > 0n && lowestAskBig > 0n ? (highestBidBig + lowestAskBig) / 2n : 0n;

        res.json({
            pairId,
            timestamp: new Date().toISOString(),
            bids,
            asks,
            spread: formatAmount(spreadBig, pair!.quoteAssetSymbol),
            rawSpread: spreadBig.toString(),
            spreadPercent,
            midPrice: formatAmount(midPriceBig, pair!.quoteAssetSymbol),
            rawMidPrice: midPriceBig.toString(),
            depth: {
                bids: bids.length,
                asks: asks.length,
            },
        });
    } catch (error: any) {
        logger.error('Error fetching orderbook:', error);
        res.status(500).json({
            message: 'Error fetching orderbook',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get merged market stats for a pair (AMM pools + Orderbook)
 * GET /market/merged-stats/:pairId
 */
router.get('/merged-stats/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;

        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) return res.status(404).json({ message: 'Trading pair not found' });

        // token symbols
        const base = pair.baseAssetSymbol;
        const quote = pair.quoteAssetSymbol;

        // Get liquidity sources (AMM pools + orderbooks)
        const sources = await liquidityAggregator.getLiquiditySources(base, quote);

        // Aggregate AMM pools
        let totalReserveA = 0n;
        let totalReserveB = 0n;
        const ammPools = sources.filter(s => s.type === 'AMM');
        for (const p of ammPools) {
            totalReserveA += toBigInt((p as any).reserveA || 0);
            totalReserveB += toBigInt((p as any).reserveB || 0);
        }

        // Best implied AMM price (quote per base): choose pool with largest reserveA
        let bestAmmPriceBig = 0n;
        if (ammPools.length > 0) {
            let maxReserveA = 0n;
            for (const p of ammPools) {
                const rA = toBigInt((p as any).reserveA || 0);
                const rB = toBigInt((p as any).reserveB || 0);
                if (rA > 0n && rB > 0n && rA >= maxReserveA) {
                    maxReserveA = rA;
                    // implied price = reserveB / reserveA scaled to quote decimals
                    // We'll keep price in raw integer form as (reserveB * 10^decimals) / reserveA
                    const quoteDecimals = getTokenDecimals(quote);
                    // Use BigInt exponentiation to avoid floating point and Number() conversions
                    const scale = BigInt(10) ** BigInt(quoteDecimals);
                    bestAmmPriceBig = (rB * scale) / rA;
                }
            }
        }

        // Aggregate orderbook data
        const orderbookSources = sources.filter(s => s.type === 'ORDERBOOK') as any[];
        let aggregatedBestBid = 0n;
        let aggregatedBestAsk = 0n;
        let aggregatedBidDepth = 0n;
        let aggregatedAskDepth = 0n;
        for (const ob of orderbookSources) {
            if (toBigInt(ob.bestBid) > aggregatedBestBid) aggregatedBestBid = toBigInt(ob.bestBid || 0);
            if (aggregatedBestAsk === 0n || (toBigInt(ob.bestAsk) > 0n && toBigInt(ob.bestAsk) < aggregatedBestAsk)) aggregatedBestAsk = toBigInt(ob.bestAsk || 0);
            aggregatedBidDepth += toBigInt(ob.bidDepth || 0);
            aggregatedAskDepth += toBigInt(ob.askDepth || 0);
        }

        // Combine AMM implied price with orderbook to compute combined best bid/ask
        // Interpret bestAmmPriceBig as quote-per-base (scaled by quote decimals)
        const combinedBestBid = aggregatedBestBid > 0n ? aggregatedBestBid : bestAmmPriceBig;
        const combinedBestAsk = aggregatedBestAsk > 0n ? aggregatedBestAsk : bestAmmPriceBig;

        const spreadBig = combinedBestAsk > 0n && combinedBestBid > 0n ? combinedBestAsk - combinedBestBid : 0n;
        // Compute spread percent as (spread / bestBid) * 100 with 4 decimal precision using BigInt math
        let spreadPercent: string = '0';
        if (combinedBestBid > 0n && spreadBig > 0n) {
            // percent_scaled = percent * 10000 (i.e., 4 decimal places)
            const percentScaled = (spreadBig * 1000000n) / combinedBestBid; // (spread * 100 * 10000) / bestBid
            const intPart = percentScaled / 10000n;
            const fracPart = percentScaled % 10000n;
            const fracStr = fracPart.toString().padStart(4, '0');
            spreadPercent = `${intPart.toString()}.${fracStr}`;
        }

        res.json({
            pairId,
            timestamp: new Date().toISOString(),
            amm: {
                pools: ammPools.length,
                totalReserveBase: formatAmount(totalReserveA, base),
                rawTotalReserveBase: totalReserveA.toString(),
                totalReserveQuote: formatAmount(totalReserveB, quote),
                rawTotalReserveQuote: totalReserveB.toString(),
                bestImpliedPrice: bestAmmPriceBig > 0n ? formatAmount(bestAmmPriceBig, quote) : null,
                rawBestImpliedPrice: bestAmmPriceBig.toString(),
            },
            orderbooks: {
                sources: orderbookSources.length,
                bestBid: aggregatedBestBid > 0n ? formatAmount(aggregatedBestBid, quote) : null,
                rawBestBid: aggregatedBestBid.toString(),
                bestAsk: aggregatedBestAsk > 0n ? formatAmount(aggregatedBestAsk, quote) : null,
                rawBestAsk: aggregatedBestAsk.toString(),
                bidDepth: aggregatedBidDepth.toString(),
                askDepth: aggregatedAskDepth.toString(),
            },
            combined: {
                bestBid: combinedBestBid > 0n ? formatAmount(combinedBestBid, quote) : null,
                rawBestBid: combinedBestBid.toString(),
                bestAsk: combinedBestAsk > 0n ? formatAmount(combinedBestAsk, quote) : null,
                rawBestAsk: combinedBestAsk.toString(),
                spread: formatAmount(spreadBig, quote),
                rawSpread: spreadBig.toString(),
                spreadPercent,
            },
        });
    } catch (error: any) {
        logger.error('Error fetching merged stats:', error);
        res.status(500).json({ message: 'Error fetching merged stats', error: error.message });
    }
}) as RequestHandler);

/**
 * Get trade history for a specific trading pair
 * GET /market/trades/:pairId
 */
router.get('/trades/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;
        const { limit = 50, since, before } = req.query;
        const period = (req.query.period as string) || 'day';

        // Check if trading pair exists
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            return res.status(404).json({ message: 'Trading pair not found' });
        }

        // Build query filter
        const filter: any = { pairId };

        // If since/before explicitly provided, honor them first
        if (since) {
            filter.timestamp = { $gte: Number(since) };
        }
        if (before) {
            filter.timestamp = filter.timestamp ? { ...filter.timestamp, $lt: Number(before) } : { $lt: Number(before) };
        }

        // If user requested a period, convert into since timestamp unless since already provided
        if (!since && period) {
            const now = Date.now();
            switch (period.toLowerCase()) {
                case 'hour':
                    filter.timestamp = { $gte: now - 60 * 60 * 1000 };
                    break;
                case 'day':
                    filter.timestamp = { $gte: now - 24 * 60 * 60 * 1000 };
                    break;
                case 'week':
                    filter.timestamp = { $gte: now - 7 * 24 * 60 * 60 * 1000 };
                    break;
                case 'month':
                    // For month/alltime prefer DB-driven path below
                    break;
                case 'alltime':
                    // no time filter
                    break;
                default:
                    filter.timestamp = { $gte: now - 24 * 60 * 60 * 1000 };
                    break;
            }
        }

        let trades: any[] = [];
        const useDbForAggregation = ['month', 'alltime'].includes((period || '').toLowerCase());
        if (!useDbForAggregation) {
            // Avoid DB timestamp filters for cache-backed path; fetch recent trades for the pair and filter in JS
            const pairFilter: any = { pairId };
            trades =
                (await cache.findPromise('trades', pairFilter, {
                    sort: { timestamp: -1 }, // Most recent first
                    limit: Math.min(Number(limit), 500), // Cap at 500 trades
                })) || [];
        } else {
            // For month/alltime, use DB to fetch recent trades page
            try {
                const db = mongo.getDb();
                const q: any = { pairId };
                if (filter.timestamp) q.timestamp = filter.timestamp;
                if (since) q.timestamp = { ...(q.timestamp || {}), $gte: Number(since) };
                if (before) q.timestamp = { ...(q.timestamp || {}), $lt: Number(before) };
                trades = await db.collection('trades').find(q).sort({ timestamp: -1 }).limit(Math.min(Number(limit), 500)).toArray();
            } catch (err) {
                logger.error('Error fetching trades via DB for large range:', err);
                trades = (await cache.findPromise('trades', filter, { sort: { timestamp: -1 }, limit: Math.min(Number(limit), 500) })) || [];
            }
        }

        // Format trade data with proper decimal handling
        const formattedTrades = trades.map(trade => {
            const priceBigInt = toBigInt(trade.price);
            const quantityBigInt = toBigInt(trade.quantity);
            const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);

            // Use the volume/total from the trade record if available (orderbook stores `total`, pool stores `volume`)
            // Fallback to recomputing if neither is present
            const volumeBigInt = trade.volume
                ? toBigInt(trade.volume)
                : trade.total
                    ? toBigInt(trade.total)
                    : (priceBigInt * quantityBigInt) / toBigInt(10) ** toBigInt(quoteDecimals);

            // Price is always represented as quote-per-base (quote token units per 1 base token)
            // so format price and volume using the quote asset symbol
            const priceTokenSymbol = pair.quoteAssetSymbol;

            // Normalize timestamp to numeric milliseconds so downstream filters work
            let timestampMs: number;
            if (typeof trade.timestamp === 'string') {
                const parsed = Date.parse(trade.timestamp);
                timestampMs = Number.isNaN(parsed) ? Date.now() : parsed;
            } else if (typeof trade.timestamp === 'number') {
                timestampMs = trade.timestamp;
            } else if (trade.timestamp instanceof Date) {
                timestampMs = trade.timestamp.getTime();
            } else {
                timestampMs = Date.now();
            }

            return {
                id: trade._id || trade.id,
                timestamp: timestampMs,
                price: priceTokenSymbol ? formatTokenAmount(priceBigInt, priceTokenSymbol) : formatTokenAmount(priceBigInt, pair.quoteAssetSymbol),
                rawPrice: priceBigInt.toString(),
                quantity: formatTokenAmount(quantityBigInt, pair.baseAssetSymbol),
                rawQuantity: quantityBigInt.toString(),
                volume: priceTokenSymbol ? formatTokenAmount(volumeBigInt, priceTokenSymbol) : formatTokenAmount(volumeBigInt, pair.quoteAssetSymbol),
                rawVolume: (trade.volume ? toBigInt(trade.volume) : trade.total ? toBigInt(trade.total) : volumeBigInt).toString(),
                total: priceTokenSymbol ? formatTokenAmount(volumeBigInt, priceTokenSymbol) : formatTokenAmount(volumeBigInt, pair.quoteAssetSymbol),
                rawTotal: (trade.total ? toBigInt(trade.total) : trade.volume ? toBigInt(trade.volume) : volumeBigInt).toString(),
                side: trade.side || 'unknown', // 'BUY' or 'SELL'
                type: trade.type || 'MARKET', // 'MARKET', 'LIMIT', etc.
                source: trade.source || 'unknown', // 'pool', 'orderbook', 'hybrid'
            };
        });

        // Calculate summary statistics
        const volume24h = formattedTrades
            .filter(trade => trade.timestamp > Date.now() - 24 * 60 * 60 * 1000)
            .reduce((sum, trade) => sum + toBigInt(trade.rawVolume), 0n);

        const priceRange =
            formattedTrades.length > 0
                ? {
                    high: Math.max(...formattedTrades.map(t => Number(t.rawPrice))),
                    low: Math.min(...formattedTrades.map(t => Number(t.rawPrice))),
                    latest: formattedTrades[0] ? Number(formattedTrades[0].rawPrice) : 0,
                    highFormatted: formatAmount(toBigInt(Math.max(...formattedTrades.map(t => Number(t.rawPrice))))),
                    lowFormatted: formatAmount(toBigInt(Math.min(...formattedTrades.map(t => Number(t.rawPrice))))),
                    latestFormatted: formattedTrades[0] ? formattedTrades[0].price : '0.00000000',
                }
                : {
                    high: 0,
                    low: 0,
                    latest: 0,
                    highFormatted: '0.00000000',
                    lowFormatted: '0.00000000',
                    latestFormatted: '0.00000000',
                };

        // If requested period is month or alltime, produce aggregated buckets for charting
        let buckets: Array<{ key: string; count: number; volume: string; rawVolume: string }> | undefined = undefined;
        const periodLower = (period || '').toLowerCase();
        if (['month', 'alltime'].includes(periodLower)) {
            try {
                const db = mongo.getDb();
                const match: any = { pairId };
                if (filter.timestamp) match.timestamp = filter.timestamp;

                // Convert timestamp to date and group by day (for month) or month (for alltime)
                const groupByFormat = periodLower === 'month' ? '%Y-%m-%d' : '%Y-%m';

                // Sum volume using either `volume` (pools) or `total` (orderbook) fields. Some deployments store
                // numeric fields as padded integer strings; $toDecimal will convert numeric strings fine.
                const agg = [
                    { $match: match },
                    { $addFields: { _tsDate: { $toDate: '$timestamp' } } },
                    {
                        $group: {
                            _id: { $dateToString: { format: groupByFormat, date: '$_tsDate' } },
                            count: { $sum: 1 },
                            volume: { $sum: { $toDecimal: { $ifNull: ['$volume', '$total', '0'] } } },
                        },
                    },
                    { $sort: { _id: 1 } },
                ];

                // Run aggregation and transform results into both raw and formatted volumes
                const aggRes = await db.collection('trades').aggregate(agg).toArray();
                const quoteSymbol = pair.quoteAssetSymbol;
                buckets = aggRes.map((r: any) => {
                    // r.volume is a Decimal128 (or number) representing the summed raw units
                    const rawVolumeStr = r.volume ? String(r.volume) : '0';
                    // Convert to BigInt for formatting using existing helpers
                    let rawVolumeBig: bigint;
                    try {
                        // Decimal128 may contain a decimal point only if fields were non-integer; handle that conservatively
                        const normalized = rawVolumeStr.includes('.') ? rawVolumeStr.split('.').join('') : rawVolumeStr;
                        rawVolumeBig = BigInt(normalized);
                    } catch (e) {
                        rawVolumeBig = 0n;
                    }

                    return {
                        key: r._id,
                        count: r.count,
                        volume: formatAmount(rawVolumeBig, quoteSymbol),
                        rawVolume: rawVolumeBig.toString(),
                    };
                });
            } catch (err) {
                logger.error('Error computing aggregation buckets for trades:', err);
                buckets = undefined;
            }
        }

        res.json({
            pairId,
            trades: formattedTrades,
            buckets,
            summary: {
                count: formattedTrades.length,
                volume24h: formatAmount(volume24h, pair.quoteAssetSymbol),
                rawVolume24h: volume24h.toString(),
                priceRange,
                timestamp: new Date().toISOString(),
            },
            pagination: {
                limit: Number(limit),
                hasMore: formattedTrades.length === Number(limit),
            },
        });

    } catch (error: any) {
        logger.error('Error fetching trades:', error);
        res.status(500).json({
            message: 'Error fetching trades',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get OHLCV candles for a trading pair
 * GET /market/candles/:pairId?interval=1m&since=...&before=...
 */
router.get('/candles/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;
        const { interval, since, before, limit } = req.query as any;
        if(!interval) {
            return res.status(400).json({ message: 'Interval parameter is required. Examples: 1m,5m,15m,1h,1d,1w' });
        }

        // Validate pair exists
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) return res.status(404).json({ message: 'Trading pair not found' });

        // Parse interval into unit & binSize (for $dateTrunc)
        function parseInterval(iv: string): { unit: string; binSize: number; ms: number } | null {
            const m = iv.match(/^(\d+)(m|h|d|w)$/i);
            if (!m) return null;
            const n = Number(m[1]);
            const u = m[2].toLowerCase();
            switch (u) {
                case 'm':
                    return { unit: 'minute', binSize: n, ms: n * 60 * 1000 };
                case 'h':
                    return { unit: 'hour', binSize: n, ms: n * 60 * 60 * 1000 };
                case 'd':
                    return { unit: 'day', binSize: n, ms: n * 24 * 60 * 60 * 1000 };
                case 'w':
                    return { unit: 'week', binSize: n, ms: n * 7 * 24 * 60 * 60 * 1000 };
                default:
                    return null;
            }
        }

        const parsed = parseInterval(String(interval));
        if (!parsed) {
            return res.status(400).json({ message: 'Invalid interval. Examples: 1m,5m,15m,1h,1d,1w' });
        }

        // Build match filter honoring both numeric and ISO string timestamps (some deployments vary)
        const match: any = { pairId };
        if (since) {
            const s = Number(since);
            match.$or = match.$or || [];
            match.$or.push({ timestamp: { $gte: s } }, { timestamp: { $gte: new Date(s).toISOString() } });
        }
        if (before) {
            const b = Number(before);
            match.$or = match.$or || [];
            match.$or.push({ timestamp: { $lt: b } }, { timestamp: { $lt: new Date(b).toISOString() } });
        }

        const db = mongo.getDb();

        // Determine caps per interval
        function intervalLimits(parsed: { unit: string; binSize: number; ms: number }) {
            // Defaults for recent data (when since/before not provided)
            let defaultLimit = 60;
            let hardCap = 1440; // default minute-based cap (1 day)

            if (parsed.unit === 'minute') {
                defaultLimit = parsed.binSize === 1 ? 60 : Math.max(1, Math.floor(1440 / parsed.binSize));
                hardCap = 1440; // allow up to 1440 minute-buckets
            } else if (parsed.unit === 'hour') {
                defaultLimit = 24; // 24 hours
                hardCap = 168; // 7 days
            } else if (parsed.unit === 'day') {
                defaultLimit = 30; // ~1 month
                hardCap = 365; // 1 year
            } else if (parsed.unit === 'week') {
                defaultLimit = 52; // ~1 year
                hardCap = 520; // ~10 years
            }

            return { defaultLimit, hardCap };
        }

        const limits = intervalLimits(parsed);
        const requestedLimit = limit ? Math.max(1, Math.min(Number(limit), limits.hardCap)) : undefined;

        // Try DB aggregation using $dateTrunc (MongoDB 5+). Sort trades ascending so $first/$last map to open/close.
        try {
            const agg: any[] = [
                { $match: match },
                { $addFields: { _tsDate: { $toDate: '$timestamp' } } },
                { $sort: { timestamp: 1 } },
                {
                    $group: {
                        _id: { $dateTrunc: { date: '$_tsDate', unit: parsed.unit, binSize: parsed.binSize } },
                        open: { $first: { $toDecimal: '$price' } },
                        high: { $max: { $toDecimal: '$price' } },
                        low: { $min: { $toDecimal: '$price' } },
                        close: { $last: { $toDecimal: '$price' } },
                        volume: { $sum: { $toDecimal: { $ifNull: ['$volume', '$total', '0'] } } },
                        count: { $sum: 1 },
                    },
                },
                // sort descending then limit to most recent N if requestedLimit or default applies, then re-sort ascending for response
                { $sort: { _id: -1 } },
            ];

            // Decide how many buckets to fetch
            let numToFetch: number | undefined = requestedLimit;
            if (!numToFetch) {
                if (since && before) {
                    const span = Math.max(0, Number(before) - Number(since));
                    const numBuckets = Math.ceil(span / parsed.ms) || 0;
                    numToFetch = Math.min(numBuckets || limits.defaultLimit, limits.hardCap) || limits.defaultLimit;
                } else if (since && !before) {
                    // from since to now
                    const span = Math.max(0, Date.now() - Number(since));
                    const numBuckets = Math.ceil(span / parsed.ms) || 0;
                    numToFetch = Math.min(Math.max(1, numBuckets), limits.hardCap);
                } else if (!since && before) {
                    // upto before from (before - defaultLimit*ms)
                    numToFetch = limits.defaultLimit;
                } else {
                    // no range provided: return sensible recent default
                    numToFetch = limits.defaultLimit;
                }
            }

            if (numToFetch && numToFetch > 0) {
                // After grouping we have buckets, so limit number of buckets
                agg.push({ $limit: numToFetch });
            }

            // re-sort ascending before returning
            agg.push({ $sort: { _id: 1 } });

            const rows = await db.collection('trades').aggregate(agg).toArray();

            // Format results
            const candles = rows.map((r: any) => {
                // r._id is a Date
                const bucketTs = r._id instanceof Date ? r._id.getTime() : new Date(r._id).getTime();

                // Decimal128/Decimal may be returned as object; stringify conservatively
                const openStr = r.open ? String(r.open) : '0';
                const highStr = r.high ? String(r.high) : '0';
                const lowStr = r.low ? String(r.low) : '0';
                const closeStr = r.close ? String(r.close) : '0';
                const volStr = r.volume ? String(r.volume) : '0';

                function toBigFromAgg(s: string): bigint {
                    try {
                        // remove possible decimal point introduced by Decimal128
                        const normalized = s.includes('.') ? s.split('.').join('') : s;
                        return BigInt(normalized);
                    } catch (e) {
                        return 0n;
                    }
                }

                const openBig = toBigFromAgg(openStr);
                const highBig = toBigFromAgg(highStr);
                const lowBig = toBigFromAgg(lowStr);
                const closeBig = toBigFromAgg(closeStr);
                const volBig = toBigFromAgg(volStr);

                const quoteSymbol = pair.quoteAssetSymbol;

                return {
                    timestamp: bucketTs,
                    open: formatAmount(openBig, quoteSymbol),
                    rawOpen: openBig.toString(),
                    high: formatAmount(highBig, quoteSymbol),
                    rawHigh: highBig.toString(),
                    low: formatAmount(lowBig, quoteSymbol),
                    rawLow: lowBig.toString(),
                    close: formatAmount(closeBig, quoteSymbol),
                    rawClose: closeBig.toString(),
                    volume: formatAmount(volBig, quoteSymbol),
                    rawVolume: volBig.toString(),
                    count: r.count || 0,
                };
            });

            // compute hasMore: estimate whether more buckets exist beyond returned window when since/before provided
            let hasMore = false;
            if ((since && before) || numToFetch) {
                // if requestedLimit was provided and rows.length === requestedLimit, we may have more
                if (requestedLimit && rows.length === requestedLimit) hasMore = true;
                // if span requires more buckets than fetched
                if (since && before) {
                    const span = Math.max(0, Number(before) - Number(since));
                    const needed = Math.ceil(span / parsed.ms);
                    if (needed > rows.length) hasMore = true;
                }
            }

            const actualSince = candles.length > 0 ? candles[0].timestamp : undefined;
            const actualBefore = candles.length > 0 ? candles[candles.length - 1].timestamp + parsed.ms : undefined;

            return res.json({ pairId, interval, candles, returned: candles.length, hasMore, requestedSince: since ? Number(since) : undefined, requestedBefore: before ? Number(before) : undefined, actualSince, actualBefore });
        } catch (err) {
            // If aggregation failed (older Mongo), fallback to JS aggregation
            logger.warn('DB aggregation for candles failed, falling back to JS aggregation:', err);

            // Fetch trades in range and bucket in JS
            const q: any = { pairId };
            if (since) q.timestamp = { ...(q.timestamp || {}), $gte: Number(since) };
            if (before) q.timestamp = { ...(q.timestamp || {}), $lt: Number(before) };

            const trades = (await cache.findPromise('trades', q, { sort: { timestamp: 1 }, limit: 20000 })) || [];

            // Bucket by interval ms
            const buckets = new Map<number, Array<any>>();
            for (const t of trades) {
                let ts = 0;
                if (typeof t.timestamp === 'number') ts = t.timestamp;
                else if (typeof t.timestamp === 'string') ts = Number.isNaN(Date.parse(t.timestamp)) ? Number(t.timestamp) : Date.parse(t.timestamp);
                else if (t.timestamp instanceof Date) ts = t.timestamp.getTime();
                else ts = Date.now();

                const key = Math.floor(ts / parsed.ms) * parsed.ms;
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key)!.push(t);
            }

            const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

            // Determine truncation per limits
            let numToReturn = requestedLimit || limits.defaultLimit;
            if (since && before) {
                const span = Math.max(0, Number(before) - Number(since));
                const needed = Math.ceil(span / parsed.ms) || 0;
                numToReturn = Math.min(needed || numToReturn, limits.hardCap);
            }

            const hasMore = sortedKeys.length > numToReturn;
            const keysToUse = hasMore ? sortedKeys.slice(sortedKeys.length - numToReturn) : sortedKeys;

            const candles = keysToUse.map(k => {
                const items = buckets.get(k) || [];
                // items sorted ascending by timestamp
                items.sort((a, b) => {
                    const at = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp);
                    const bt = typeof b.timestamp === 'number' ? b.timestamp : Date.parse(b.timestamp);
                    return at - bt;
                });

                const openBig = items.length ? toBigInt(items[0].price || 0) : 0n;
                const closeBig = items.length ? toBigInt(items[items.length - 1].price || 0) : 0n;
                const highBig = items.reduce((m, it) => { const p = toBigInt(it.price || 0); return p > m ? p : m; }, 0n);
                const lowBig = items.reduce((m, it) => { const p = toBigInt(it.price || 0); return m === 0n || p < m ? p : m; }, 0n);
                const volBig = items.reduce((s, it) => s + toBigInt(it.volume || it.total || 0), 0n);

                const quoteSymbol = pair.quoteAssetSymbol;

                return {
                    timestamp: k,
                    open: formatAmount(openBig, quoteSymbol),
                    rawOpen: openBig.toString(),
                    high: formatAmount(highBig, quoteSymbol),
                    rawHigh: highBig.toString(),
                    low: formatAmount(lowBig, quoteSymbol),
                    rawLow: lowBig.toString(),
                    close: formatAmount(closeBig, quoteSymbol),
                    rawClose: closeBig.toString(),
                    volume: formatAmount(volBig, quoteSymbol),
                    rawVolume: volBig.toString(),
                    count: items.length,
                };
            });

            const actualSince = candles.length > 0 ? candles[0].timestamp : undefined;
            const actualBefore = candles.length > 0 ? candles[candles.length - 1].timestamp + parsed.ms : undefined;

            return res.json({ pairId, interval, candles, returned: candles.length, hasMore, requestedSince: since ? Number(since) : undefined, requestedBefore: before ? Number(before) : undefined, actualSince, actualBefore });
        }
    } catch (error: any) {
        logger.error('Error fetching candles:', error);
        res.status(500).json({ message: 'Error fetching candles', error: error.message });
    }
}) as RequestHandler);

/**
 * Health check for hybrid system
 * GET /hybrid/health
 */
router.get('/health', (async (req: Request, res: Response) => {
    try {
        // Check if both AMM and orderbook systems are operational
        const health = {
            status: 'HEALTHY' as 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY',
            timestamp: new Date().toISOString(),
            systems: {
                amm: {
                    status: 'OPERATIONAL',
                    pools: 0, // Would be fetched from database
                    lastUpdate: new Date().toISOString(),
                },
                orderbook: {
                    status: 'OPERATIONAL',
                    pairs: 0, // Would be fetched from database
                    lastUpdate: new Date().toISOString(),
                },
                aggregator: {
                    status: 'OPERATIONAL',
                    lastQuote: new Date().toISOString(),
                },
            },
        };

        res.json(health);
    } catch (error: any) {
        logger.error('Error checking hybrid system health:', error);
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString(),
        });
    }
}) as RequestHandler);

/**
 * Helper functions
 */
function formatAmount(amount: bigint, tokenSymbol?: string): string {
    // Format based on token-specific decimal scaling for display
    if (tokenSymbol) {
        const decimals = getTokenDecimals(tokenSymbol);
        const divisor = Math.pow(10, decimals);
        // For price, if the symbol is used for price display, force to use quote asset decimals (3 for TESTS)
        // If you want to force fewer decimals for price, you can clamp or set a max here
        return (Number(amount) / divisor).toFixed(decimals);
    }
    // Fallback to 8 decimals for backward compatibility
    return (Number(amount) / 1e8).toFixed(8);
}

function getBestRouteRecommendation(quote: any): string {
    if (quote.routes.length === 1) {
        return quote.routes[0].type === 'AMM' ? 'Single AMM pool provides best price' : 'Orderbook provides best price';
    }

    return 'Hybrid routing across multiple sources provides optimal execution';
}

// ===== ORDERBOOK ENDPOINTS (for compatibility) =====

/**
 * Get all trading pairs
 * GET /market/pairs
 */
router.get('/pairs', (async (req: Request, res: Response) => {
    try {
        const pairs = await cache.findPromise('tradingPairs', {});
        res.json({
            pairs: pairs || [],
            total: pairs?.length || 0,
        });
    } catch (error: any) {
        logger.error('Error fetching trading pairs:', error);
        res.status(500).json({
            message: 'Error fetching trading pairs',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get specific trading pair
 * GET /market/pairs/:pairId
 */
router.get('/pairs/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });

        if (!pair) {
            return res.status(404).json({ message: 'Trading pair not found' });
        }

        res.json(pair);
    } catch (error: any) {
        logger.error('Error fetching trading pair:', error);
        res.status(500).json({
            message: 'Error fetching trading pair',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get orders for a trading pair
 * GET /market/orders/pair/:pairId
 */
router.get('/orders/pair/:pairId', (async (req: Request, res: Response) => {
    try {
        const { pairId } = req.params;
        const orders = await cache.findPromise('orders', { pairId }, { sort: { timestamp: -1 } });

        res.json({
            pairId,
            orders: orders || [],
            total: orders?.length || 0,
        });
    } catch (error: any) {
        logger.error('Error fetching orders for pair:', error);
        res.status(500).json({
            message: 'Error fetching orders',
            error: error.message,
        });
    }
}) as RequestHandler);

/**
 * Get orders for a specific user with optional pair filtering
 * GET /market/orders/:userId?pairId=PAIR_ID
 */
router.get('/orders/user/:userId', (async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const { pairId, status, side, limit = 100 } = req.query;

        // Build query filter
        const filter: any = { userId };

        if (pairId) {
            filter.pairId = pairId;
        }

        if (status === 'active') {
            filter.status = { $in: ['OPEN', 'PARTIALLY_FILLED'] };
        } else if (status) {
            filter.status = status;
        } else {
            // By default, exclude cancelled and rejected orders
            filter.status = { $in: ['CANCELLED', 'REJECTED', 'EXPIRED', 'FILLED'] };
        }

        if (side) {
            filter.side = side;
        }

        // Get orders with optional filtering
        const orders =
            (await cache.findPromise('orders', filter, {
                sort: { createdAt: -1 }, // Most recent first
                limit: Math.min(Number(limit), 500), // Cap at 500 orders
            })) || [];

        // Get trading pair information for proper decimal formatting
        const pairIds = [...new Set(orders.map(order => order.pairId))];
        const pairs = await Promise.all(
            pairIds.map(async id => {
                const pair = await cache.findOnePromise('tradingPairs', { _id: id });
                return { [id]: pair };
            })
        );
        const pairMap = pairs.reduce((acc, pair) => ({ ...acc, ...pair }), {});

        // Format order data
        const formattedOrders = orders.map(order => {
            const pair = pairMap[order.pairId];
            const baseSymbol = pair?.baseAssetSymbol || 'UNKNOWN';
            const quoteSymbol = pair?.quoteAssetSymbol || 'UNKNOWN';
            return {
                id: order._id || order.id,
                pairId: order.pairId,
                side: order.side,
                type: order.type,
                price: order.price ? formatAmount(toBigInt(order.price), quoteSymbol) : null,
                rawPrice: order.price ? toBigInt(order.price).toString() : null,
                quantity: formatAmount(toBigInt(order.quantity), baseSymbol),
                rawQuantity: toBigInt(order.quantity).toString(),
                remainingQuantity: formatAmount(toBigInt(order.remainingQuantity || 0), baseSymbol),
                rawRemainingQuantity: toBigInt(order.remainingQuantity || 0).toString(),
                filledQuantity: formatAmount(toBigInt(order.filledQuantity || 0), baseSymbol),
                rawFilledQuantity: toBigInt(order.filledQuantity || 0).toString(),
                status: order.status,
                timestamp: order.createdAt || order.timestamp,
                lastUpdateTime: order.lastUpdateTime,
            };
        });

        // Calculate summary statistics
        const summary = {
            totalOrders: formattedOrders.length,
            openOrders: formattedOrders.filter(o => o.status === 'OPEN').length,
            partialOrders: formattedOrders.filter(o => o.status === 'PARTIALLY_FILLED').length,
            filledOrders: formattedOrders.filter(o => o.status === 'FILLED').length,
            cancelledOrders: formattedOrders.filter(o => o.status === 'CANCELLED').length,
            buyOrders: formattedOrders.filter(o => o.side === 'BUY').length,
            sellOrders: formattedOrders.filter(o => o.side === 'SELL').length,
        };

        res.json({
            userId,
            pairId: pairId || 'all',
            orders: formattedOrders,
            summary,
            filters: {
                pairId: pairId || null,
                status: status || null,
                side: side || null,
                limit: Number(limit),
            },
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        logger.error('Error fetching user orders:', error);
        res.status(500).json({
            message: 'Error fetching user orders',
            error: error.message,
        });
    }
}) as RequestHandler);

export default router;
