import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt, toDbString as bigintToString, parseTokenAmount, formatTokenAmount } from '../../utils/bigint.js';
import { getTokenDecimals } from '../../utils/bigint.js';
import { getOutputAmountBigInt, calculatePriceImpact } from '../../utils/pool.js';
import { formatTokenAmountForResponse, formatTokenAmountSimple } from '../../utils/http.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// --- Types for Swap Routing (MODIFIED) ---
interface Pool {
    _id: string; // e.g., TOKENA-TOKENB
    tokenA_symbol: string;
    tokenA_reserve: string; // Padded BigInt string
    tokenB_symbol: string;
    tokenB_reserve: string; // Padded BigInt string
    precisionFactor?: bigint; // e.g. 10n**18n for precision in intermediate calcs, if needed
}

interface TradeHop {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string; // Padded BigInt string, for this specific hop
    amountOut: string; // Padded BigInt string, for this specific hop
    priceImpact: number; // Price impact percentage for this hop
}

interface TradeRoute {
    hops: TradeHop[];
    finalAmountIn: string; // Padded BigInt string (initial amount for the whole route)
    finalAmountOut: string; // Padded BigInt string (final amount out for the whole route)
}

/**
 * Finds all possible trade routes from a start token to an end token using BigInt.
 */
async function findAllTradeRoutesBigInt(
    startTokenSymbol: string,
    endTokenSymbol: string,
    initialAmountInString: string, // Assumed to be string of smallest units
    maxHops: number = 3 
): Promise<TradeRoute[]> {
    const startTokenDecimals = getTokenDecimals(startTokenSymbol);
    if (startTokenDecimals === undefined) {
        logger.error(`Decimals not found for start token ${startTokenSymbol} in findAllTradeRoutesBigInt`);
        return [];
    }
    const initialAmountInBigInt = toBigInt(initialAmountInString);

    const allPoolsFromDB: any[] = await mongo.getDb().collection('liquidityPools').find({}).toArray();
    const allPools: Pool[] = allPoolsFromDB.map(p => ({
        ...p,
        _id: p._id.toString(), // ensure _id is string
        tokenA_reserve: p.tokenA_reserve as string,
        tokenB_reserve: p.tokenB_reserve as string,
    }));

    const routes: TradeRoute[] = [];
    const queue: [string, TradeHop[], bigint][] = [[startTokenSymbol, [], initialAmountInBigInt]];
    
    while (queue.length > 0) {
        const [currentTokenSymbol, currentPath, currentAmountInBigInt] = queue.shift()!;
        if (currentPath.length >= maxHops) continue;
        
        for (const pool of allPools) {
            let tokenInReserveStr: string, tokenOutReserveStr: string, nextTokenSymbol: string;
            
            if (pool.tokenA_symbol === currentTokenSymbol) {
                tokenInReserveStr = pool.tokenA_reserve;
                tokenOutReserveStr = pool.tokenB_reserve;
                nextTokenSymbol = pool.tokenB_symbol;
            } else if (pool.tokenB_symbol === currentTokenSymbol) {
                tokenInReserveStr = pool.tokenB_reserve;
                tokenOutReserveStr = pool.tokenA_reserve;
                nextTokenSymbol = pool.tokenA_symbol;
            } else {
                continue; 
            }

            const tokenInReserveBigInt = toBigInt(tokenInReserveStr);
            const tokenOutReserveBigInt = toBigInt(tokenOutReserveStr);
            if (tokenInReserveBigInt <= 0n || tokenOutReserveBigInt <= 0n) continue;
            if (currentPath.length > 0 && currentPath[currentPath.length -1].tokenIn === nextTokenSymbol) continue;
            
            const amountOutFromHopBigInt = getOutputAmountBigInt( currentAmountInBigInt, tokenInReserveBigInt, tokenOutReserveBigInt );
            if (amountOutFromHopBigInt <= 0n) continue;
            
            // Calculate price impact for this hop
            const priceImpact = calculatePriceImpact(currentAmountInBigInt, tokenInReserveBigInt);
            
            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentTokenSymbol,
                tokenOut: nextTokenSymbol,
                amountIn: bigintToString(currentAmountInBigInt),
                amountOut: bigintToString(amountOutFromHopBigInt),
                priceImpact: priceImpact
            };
            const newPath = [...currentPath, newHop];
            
            if (nextTokenSymbol === endTokenSymbol) {
                routes.push({ 
                    hops: newPath, 
                    finalAmountIn: bigintToString(initialAmountInBigInt),
                    finalAmountOut: bigintToString(amountOutFromHopBigInt)
                });
            } else {
                queue.push([nextTokenSymbol, newPath, amountOutFromHopBigInt]);
            }
        }
    }
    return routes.sort((a, b) => toBigInt(b.finalAmountOut) - toBigInt(a.finalAmountOut) > 0n ? 1 : -1 );
}

const transformPoolData = (poolData: any): any => {
    if (!poolData) return poolData;
    const transformed = { ...poolData };
    transformed.id = transformed._id.toString();
    if (transformed._id && transformed.id !== transformed._id) delete transformed._id;

    // Format token reserves with proper decimals
    if (transformed.tokenA_reserve) {
        const formattedReserve = formatTokenAmountForResponse(transformed.tokenA_reserve, transformed.tokenA_symbol);
        transformed.tokenA_reserve = formattedReserve.amount;
        transformed.rawTokenA_reserve = formattedReserve.rawAmount;
    }
    if (transformed.tokenB_reserve) {
        const formattedReserve = formatTokenAmountForResponse(transformed.tokenB_reserve, transformed.tokenB_symbol);
        transformed.tokenB_reserve = formattedReserve.amount;
        transformed.rawTokenB_reserve = formattedReserve.rawAmount;
    }
    if (transformed.totalLpTokens) {
        const lpTokensBigInt = toBigInt(transformed.totalLpTokens);
        transformed.totalLpTokens = lpTokensBigInt.toString();
        transformed.rawTotalLpTokens = lpTokensBigInt.toString();
    }
    // --- Fee accounting fields ---
    if (poolData.feeGrowthGlobalA !== undefined) {
        transformed.feeGrowthGlobalA = poolData.feeGrowthGlobalA.toString();
    }
    if (poolData.feeGrowthGlobalB !== undefined) {
        transformed.feeGrowthGlobalB = poolData.feeGrowthGlobalB.toString();
    }
    return transformed;
};

const transformUserLiquidityPositionData = (positionData: any, poolData?: any): any => {
    if (!positionData) return positionData;
    const transformed = { ...positionData };
    transformed.id = transformed._id.toString();
    if (transformed._id && transformed.id !== transformed._id) delete transformed._id;
    if (transformed.lpTokenBalance) {
        const lpBalanceBigInt = toBigInt(transformed.lpTokenBalance);
        transformed.lpTokenBalance = formatTokenAmount(lpBalanceBigInt, 'LP_TOKEN');
        transformed.rawLpTokenBalance = lpBalanceBigInt.toString();
    }
    // --- Fee accounting fields ---
    if (positionData.feeGrowthEntryA !== undefined) {
        transformed.feeGrowthEntryA = positionData.feeGrowthEntryA.toString();
    }
    if (positionData.feeGrowthEntryB !== undefined) {
        transformed.feeGrowthEntryB = positionData.feeGrowthEntryB.toString();
    }
    if (positionData.unclaimedFeesA !== undefined) {
        transformed.unclaimedFeesA = positionData.unclaimedFeesA.toString();
    }
    if (positionData.unclaimedFeesB !== undefined) {
        transformed.unclaimedFeesB = positionData.unclaimedFeesB.toString();
    }
    // Optionally, compute claimable fees if poolData is provided
    if (poolData) {
        const lpTokenBalance = toBigInt(positionData.lpTokenBalance || '0');
        const feeGrowthEntryA = toBigInt(positionData.feeGrowthEntryA || '0');
        const feeGrowthEntryB = toBigInt(positionData.feeGrowthEntryB || '0');
        const unclaimedFeesA = toBigInt(positionData.unclaimedFeesA || '0');
        const unclaimedFeesB = toBigInt(positionData.unclaimedFeesB || '0');
        const feeGrowthGlobalA = toBigInt(poolData.feeGrowthGlobalA || '0');
        const feeGrowthGlobalB = toBigInt(poolData.feeGrowthGlobalB || '0');
        transformed.claimableFeesA = ((feeGrowthGlobalA - feeGrowthEntryA) * lpTokenBalance / BigInt(1e18) + unclaimedFeesA).toString();
        transformed.claimableFeesB = ((feeGrowthGlobalB - feeGrowthEntryB) * lpTokenBalance / BigInt(1e18) + unclaimedFeesB).toString();
    }
    return transformed;
};

// --- Liquidity Pools ---
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const poolsFromDB = await cache.findPromise('liquidityPools', {}, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('liquidityPools').countDocuments({});
        // For APR calculation, fetch swap events for each pool for the last 365 days
        const now = new Date();
        const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        const poolIds = (poolsFromDB || []).map(p => (p._id ?? '').toString()).filter(id => !!id);
        // Fetch all swap events for all pools in the page in one query
        const eventsByPool: Record<string, any[]> = {};
        if (poolIds.length > 0) {
            const events = await mongo.getDb().collection('events').find({
                'type': 'poolSwap',
                'data.poolId': { $in: poolIds },
                'timestamp': { $gte: yearAgo.toISOString() }
            }).toArray();
            for (const event of events) {
                const poolId = event.data?.poolId?.toString();
                if (!poolId) continue;
                if (!eventsByPool[poolId]) eventsByPool[poolId] = [];
                eventsByPool[poolId].push(event);
            }
        }
        // For 24h fees calculation
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        let events24hByPool: Record<string, any[]> = {};
        if (poolIds.length > 0) {
            const events24h = await mongo.getDb().collection('events').find({
                'type': 'poolSwap',
                'data.poolId': { $in: poolIds },
                'timestamp': { $gte: dayAgo.toISOString() }
            }).toArray();
            for (const event of events24h) {
                const poolId = event.data?.poolId?.toString();
                if (!poolId) continue;
                if (!events24hByPool[poolId]) events24hByPool[poolId] = [];
                events24hByPool[poolId].push(event);
            }
        }
        const pools = (poolsFromDB || []).map(poolData => {
            const poolIdStr = (poolData._id ?? '').toString();
            if (!poolIdStr) return null; // skip pools without _id
            // Calculate yearly APR for each pool
            let totalFeesA = 0n, totalFeesB = 0n;
            const events = eventsByPool[poolIdStr] || [];
            for (const event of events) {
                const e = event.data;
                const feeDivisor = BigInt(10000);
                const amountIn = toBigInt(e.amountIn);
                const tokenIn = e.tokenIn_symbol;
                const feeAmount = (amountIn * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
                if (tokenIn === e.tokenA_symbol || tokenIn === e.tokenIn_symbol) {
                    totalFeesA += feeAmount;
                } else {
                    totalFeesB += feeAmount;
                }
            }
            // Calculate 24h fees for each pool
            let fees24hA = 0n, fees24hB = 0n;
            const events24h = events24hByPool[poolIdStr] || [];
            for (const event of events24h) {
                const e = event.data;
                const feeDivisor = BigInt(10000);
                const amountIn = toBigInt(e.amountIn);
                const tokenIn = e.tokenIn_symbol;
                const feeAmount = (amountIn * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
                if (tokenIn === e.tokenA_symbol || tokenIn === e.tokenIn_symbol) {
                    fees24hA += feeAmount;
                } else {
                    fees24hB += feeAmount;
                }
            }
            const tvlA = toBigInt(poolData.tokenA_reserve || '0');
            const tvlB = toBigInt(poolData.tokenB_reserve || '0');
            let aprA = 0, aprB = 0;
            if (tvlA > 0n) {
                aprA = Number(totalFeesA) / Number(tvlA);
            }
            if (tvlB > 0n) {
                aprB = Number(totalFeesB) / Number(tvlB);
            }
            const transformed = transformPoolData(poolData);
            transformed.aprA = aprA;
            transformed.aprB = aprB;
            transformed.fees24hA = fees24hA.toString();
            transformed.fees24hB = fees24hB.toString();
            return transformed;
        }).filter(Boolean);
        res.json({ data: pools, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching liquidity pools:', error);
        res.status(500).json({ message: 'Error fetching liquidity pools', error: error.message });
    }
}) as RequestHandler);

// GET /pools/count - Get total number of liquidity pools
router.get('/count', (async (req: Request, res: Response) => {
    try {
        const query: any = {};
        
        // Apply filters if provided (similar to main pools endpoint)
        if (req.query.hasLiquidity === 'true') {
            // Only count pools with actual liquidity
            query.$or = [
                { tokenA_reserve: { $gt: '0' } },
                { tokenB_reserve: { $gt: '0' } }
            ];
        }
        
        if (req.query.tokenSymbol) {
            const tokenSymbol = req.query.tokenSymbol as string;
            query.$or = [
                { tokenA_symbol: tokenSymbol },
                { tokenB_symbol: tokenSymbol }
            ];
        }
        
        const totalPools = await mongo.getDb().collection('liquidityPools').countDocuments(query);
        
        res.json({ 
            success: true, 
            count: totalPools,
            filters: {
                hasLiquidity: req.query.hasLiquidity === 'true' || false,
                tokenSymbol: req.query.tokenSymbol || null
            }
        });
    } catch (error: any) {
        logger.error('Error fetching pools count:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}) as RequestHandler);

router.get('/:poolId', (async (req: Request, res: Response) => {
    const { poolId } = req.params;
    try {
        const poolFromDB = await cache.findOnePromise('liquidityPools', { _id: poolId });
        if (!poolFromDB) {
            return res.status(404).json({ message: `Liquidity pool ${poolId} not found.` });
        }
        res.json(transformPoolData(poolFromDB));
    } catch (error: any) {
        logger.error(`Error fetching liquidity pool ${poolId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity pool', error: error.message });
    }
}) as RequestHandler);

router.get('/token/:tokenSymbol', (async (req: Request, res: Response) => {
    const { tokenSymbol } = req.params;
    const { limit, skip } = getPagination(req);
    const query = {
        $or: [
            { tokenA_symbol: tokenSymbol },
            { tokenB_symbol: tokenSymbol }
        ]
    };
    try {
        const poolsFromDB = await cache.findPromise('liquidityPools', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('liquidityPools').countDocuments(query);
        const pools = (poolsFromDB || []).map(transformPoolData);
        res.json({ data: pools, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching pools for token ${tokenSymbol}:`, error);
        res.status(500).json({ message: 'Error fetching pools by token', error: error.message });
    }
}) as RequestHandler);

// --- User Liquidity Positions ---
router.get('/positions/user/:userId', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const positionsFromDB = await cache.findPromise('userLiquidityPositions', { user: userId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userLiquidityPositions').countDocuments({ user: userId });
        const positions = (positionsFromDB || []).map(transformUserLiquidityPositionData);
        res.json({ data: positions, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching liquidity positions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity positions for user', error: error.message });
    }
}) as RequestHandler);

router.get('/positions/pool/:poolId', (async (req: Request, res: Response) => {
    const { poolId } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const positionsFromDB = await cache.findPromise('userLiquidityPositions', { poolId: poolId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userLiquidityPositions').countDocuments({ poolId: poolId });
        const positions = (positionsFromDB || []).map(transformUserLiquidityPositionData);
        res.json({ data: positions, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching liquidity positions for pool ${poolId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity positions for pool', error: error.message });
    }
}) as RequestHandler);

// Get specific position by its composite ID (user-poolId)
router.get('/positions/:positionId', (async (req: Request, res: Response) => {
    const { positionId } = req.params;
    try {
        const positionFromDB = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `Liquidity position ${positionId} not found.` });
        }
        const poolFromDB = await cache.findOnePromise('liquidityPools', { _id: positionFromDB.poolId });
        res.json(transformUserLiquidityPositionData(positionFromDB, poolFromDB));
    } catch (error: any) {
        logger.error(`Error fetching liquidity position ${positionId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity position', error: error.message });
    }
}) as RequestHandler);

// Get a specific user's liquidity position in a specific pool
router.get('/positions/user/:userId/pool/:poolId', (async (req: Request, res: Response) => {
    const { userId, poolId } = req.params;
    const positionId = `${userId}_${poolId}`;
    try {
        const positionFromDB = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `Liquidity position for user ${userId} in pool ${poolId} not found.` });
        }
        const poolFromDB = await cache.findOnePromise('liquidityPools', { _id: poolId });
        res.json(transformUserLiquidityPositionData(positionFromDB, poolFromDB));
    } catch (error: any) {
        logger.error(`Error fetching position for user ${userId} in pool ${poolId}:`, error);
        res.status(500).json({ message: 'Error fetching user liquidity position in pool', error: error.message });
    }
}) as RequestHandler);

// POST /pools/route-swap - Find the best swap route
router.post('/route-swap', (async (req: Request, res: Response) => {
    const { fromTokenSymbol, toTokenSymbol, amountIn, slippage } = req.body;

    if (!fromTokenSymbol || !toTokenSymbol || !amountIn) {
        return res.status(400).json({ message: 'Missing required body parameters: fromTokenSymbol, toTokenSymbol, amountIn.' });
    }
    if (typeof fromTokenSymbol !== 'string' || typeof toTokenSymbol !== 'string') {
        return res.status(400).json({ message: 'fromTokenSymbol and toTokenSymbol must be strings.' });
    }
    if (typeof amountIn !== 'string' && typeof amountIn !== 'number') {
        return res.status(400).json({ message: 'amountIn must be a string or number.' });
    }

    // Parse slippage parameter (optional, default 0.5%)
    const slippagePercent = slippage !== undefined ? Number(slippage) : 0.5;
    if (slippagePercent < 0 || slippagePercent > 100) {
        return res.status(400).json({ message: 'Slippage must be between 0 and 100 percent.' });
    }

    if (fromTokenSymbol === toTokenSymbol) {
        return res.status(400).json({ message: 'Input and output tokens cannot be the same.' });
    }

    let amountInBigInt: bigint;
    try {
        // Convert input amount to string if it's a number
        const amountInStr = typeof amountIn === 'number' ? amountIn.toString() : amountIn;
        // Convert input amount (e.g., "1.23") to smallest unit BigInt (e.g., 123000000n)
        amountInBigInt = parseTokenAmount(amountInStr, fromTokenSymbol);
        if (amountInBigInt <= 0n) { // parseTokenAmount already throws for invalid format
            return res.status(400).json({ message: `Invalid amountIn: ${amountIn}. Must result in a positive value in smallest units.` });
        }
    } catch (error: any) {
        logger.error(`Error parsing amountIn for swap route: ${amountIn}, token: ${fromTokenSymbol}`, error);
        return res.status(400).json({ 
            message: `Invalid amountIn '${amountIn}' for token '${fromTokenSymbol}'. Error: ${error.message}`,
            error: error.message 
        });
    }
    // Now convert the bigint to string for findAllTradeRoutesBigInt
    const amountInSmallestUnitStr = bigintToString(amountInBigInt);

    try {
        const routes: TradeRoute[] = await findAllTradeRoutesBigInt(
            fromTokenSymbol,
            toTokenSymbol,
            amountInSmallestUnitStr // Pass the smallest unit string
        );

        if (!routes || routes.length === 0) {
            return res.status(404).json({ message: 'No trade route found.' });
        }

        const bestRoute = routes[0]; 
        
        const transformRouteForAPI = (route: TradeRoute): any => {
            // Calculate slippage-adjusted amounts for each hop
            const hopsWithSlippage = route.hops.map(hop => {
                const expectedAmountOut = toBigInt(hop.amountOut);
                const slippageMultiplier = BigInt(10000 - Math.floor(slippagePercent * 100));
                const minAmountOut = (expectedAmountOut * slippageMultiplier) / BigInt(10000);
                
                return {
                    ...hop,
                    amountIn: toBigInt(hop.amountIn).toString(),
                    amountOut: toBigInt(hop.amountOut).toString(),
                    amountInFormatted: formatTokenAmountSimple(toBigInt(hop.amountIn), hop.tokenIn),
                    amountOutFormatted: formatTokenAmountSimple(toBigInt(hop.amountOut), hop.tokenOut),
                    minAmountOut: minAmountOut.toString(),
                    minAmountOutFormatted: formatTokenAmountSimple(minAmountOut, hop.tokenOut),
                    slippagePercent: slippagePercent,
                    priceImpact: hop.priceImpact,
                    priceImpactFormatted: `${hop.priceImpact.toFixed(4)}%`
                };
            });

            // Calculate slippage-adjusted final amounts
            const finalAmountOut = toBigInt(route.finalAmountOut);
            const slippageMultiplier = BigInt(10000 - Math.floor(slippagePercent * 100));
            const minFinalAmountOut = (finalAmountOut * slippageMultiplier) / BigInt(10000);

            // Calculate total price impact for the route (sum of all hops)
            const totalPriceImpact = route.hops.reduce((total, hop) => total + hop.priceImpact, 0);

            return {
                ...route,
                finalAmountIn: toBigInt(route.finalAmountIn).toString(),
                finalAmountOut: toBigInt(route.finalAmountOut).toString(),
                finalAmountInFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountIn), fromTokenSymbol),
                finalAmountOutFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountOut), toTokenSymbol),
                minFinalAmountOut: minFinalAmountOut.toString(),
                minFinalAmountOutFormatted: formatTokenAmountSimple(minFinalAmountOut, toTokenSymbol),
                slippagePercent: slippagePercent,
                totalPriceImpact: totalPriceImpact,
                totalPriceImpactFormatted: `${totalPriceImpact.toFixed(4)}%`,
                hops: hopsWithSlippage
            };
        };

        res.json({ bestRoute: transformRouteForAPI(bestRoute), allRoutes: routes.map(transformRouteForAPI) });
    } catch (error: any) {
        logger.error(`Error finding swap route for ${fromTokenSymbol}->${toTokenSymbol}:`, error);
        res.status(500).json({ message: 'Error finding swap route', error: error.message });
    }
}) as RequestHandler);

// --- Pool Analytics ---
// GET /pools/:poolId/analytics?period=hour|day|week|month|year[&interval=hour|day|week]
router.get('/:poolId/analytics', (async (req: Request, res: Response) => {
    const { poolId } = req.params;
    const period = req.query.period as string || 'day'; // default to 'day'
    const intervalParam = req.query.interval as string | undefined;
    const validPeriods = ['hour', 'day', 'week', 'month', 'year'];
    const validIntervals = ['hour', 'day', 'week'];
    if (!validPeriods.includes(period)) {
        return res.status(400).json({ message: `Invalid period. Must be one of: ${validPeriods.join(', ')}` });
    }
    // Calculate start time for the period
    const now = new Date();
    let startTime: Date;
    let defaultInterval: string;
    switch (period) {
        case 'hour': startTime = new Date(now.getTime() - 60 * 60 * 1000); defaultInterval = 'minute'; break;
        case 'day': startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); defaultInterval = 'hour'; break;
        case 'week': startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); defaultInterval = 'day'; break;
        case 'month': startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); defaultInterval = 'day'; break;
        case 'year': startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); defaultInterval = 'month'; break;
        default: startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); defaultInterval = 'hour';
    }
    // Determine interval
    let interval = intervalParam;
    if (!interval) {
        // Auto-select interval for ~10 buckets
        const ms = now.getTime() - startTime.getTime();
        const approxBucketMs = Math.max(Math.floor(ms / 10), 1);
        if (ms <= 2 * 60 * 60 * 1000) interval = 'minute'; // <=2h: minute
        else if (ms <= 2 * 24 * 60 * 60 * 1000) interval = 'hour'; // <=2d: hour
        else if (ms <= 60 * 24 * 60 * 60 * 1000) interval = 'day'; // <=2mo: day
        else interval = 'week';
    }
    // If interval is not valid, fallback to defaultInterval
    if (!['minute', 'hour', 'day', 'week', 'month'].includes(interval)) interval = defaultInterval;
    try {
        // Get all swap events for this pool in the period
        const events = await mongo.getDb().collection('events').find({
            'type': 'poolSwap',
            'data.poolId': poolId,
            'timestamp': { $gte: startTime.toISOString() }
        }).toArray();
        // If interval is not set or is 'aggregate', return aggregate as before
        if (!interval || interval === 'aggregate') {
            // Calculate total volume and fees
            let totalVolumeA = 0n, totalVolumeB = 0n, totalFeesA = 0n, totalFeesB = 0n;
            for (const event of events) {
                const e = event.data;
                const feeDivisor = BigInt(10000);
                const amountIn = toBigInt(e.amountIn);
                const tokenIn = e.tokenIn_symbol;
                // Fee is always taken from amountIn (fixed 0.3% fee)
                const feeAmount = (amountIn * BigInt(300)) / feeDivisor;
                if (tokenIn === e.tokenA_symbol || tokenIn === e.tokenIn_symbol) {
                    totalVolumeA += amountIn;
                    totalFeesA += feeAmount;
                } else {
                    totalVolumeB += amountIn;
                    totalFeesB += feeAmount;
                }
            }
            // Get pool state for TVL and APR calculation
            const poolFromDB = await cache.findOnePromise('liquidityPools', { _id: poolId });
            if (!poolFromDB) {
                return res.status(404).json({ message: `Liquidity pool ${poolId} not found.` });
            }
            const pool = poolFromDB;
            // TVL = tokenA_reserve + tokenB_reserve (in raw units)
            const tvlA = toBigInt(pool.tokenA_reserve || '0');
            const tvlB = toBigInt(pool.tokenB_reserve || '0');
            // APR = (fees in period * periods per year) / TVL
            // For simplicity, use tokenA as base for APR
            let aprA = 0, aprB = 0;
            const periodsPerYear: Record<string, number> = { hour: 8760, day: 365, week: 52, month: 12, year: 1 };
            if (tvlA > 0n) {
                aprA = Number(totalFeesA) * periodsPerYear[period] / Number(tvlA);
            }
            if (tvlB > 0n) {
                aprB = Number(totalFeesB) * periodsPerYear[period] / Number(tvlB);
            }
            return res.json({
                poolId,
                period,
                from: startTime.toISOString(),
                to: now.toISOString(),
                totalVolumeA: totalVolumeA.toString(),
                totalVolumeB: totalVolumeB.toString(),
                totalFeesA: totalFeesA.toString(),
                totalFeesB: totalFeesB.toString(),
                tvlA: tvlA.toString(),
                tvlB: tvlB.toString(),
                aprA,
                aprB
            });
        }
        // Otherwise, return time-series data
        // Determine bucket size in ms
        let bucketMs = 0;
        switch (interval) {
            case 'minute': bucketMs = 60 * 1000; break;
            case 'hour': bucketMs = 60 * 60 * 1000; break;
            case 'day': bucketMs = 24 * 60 * 60 * 1000; break;
            case 'week': bucketMs = 7 * 24 * 60 * 60 * 1000; break;
            case 'month': bucketMs = 30 * 24 * 60 * 60 * 1000; break;
            default: bucketMs = 60 * 60 * 1000;
        }
        // Prepare buckets
        const bucketCount = Math.ceil((now.getTime() - startTime.getTime()) / bucketMs);
        const buckets: Array<{
            timestamp: string,
            volumeA: bigint,
            volumeB: bigint,
            feesA: bigint,
            feesB: bigint
        }> = [];
        for (let i = 0; i < bucketCount; i++) {
            const bucketStart = new Date(startTime.getTime() + i * bucketMs);
            buckets.push({
                timestamp: bucketStart.toISOString(),
                volumeA: 0n,
                volumeB: 0n,
                feesA: 0n,
                feesB: 0n
            });
        }
        // Assign events to buckets
        for (const event of events) {
            const e = event.data;
            const createdAt = new Date(event.timestamp).getTime();
            const bucketIdx = Math.floor((createdAt - startTime.getTime()) / bucketMs);
            if (bucketIdx < 0 || bucketIdx >= buckets.length) continue;
            const feeDivisor = BigInt(10000);
            const amountIn = toBigInt(e.amountIn);
            const tokenIn = e.tokenIn_symbol;
            const feeAmount = (amountIn * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
            if (tokenIn === e.tokenA_symbol || tokenIn === e.tokenIn_symbol) {
                buckets[bucketIdx].volumeA += amountIn;
                buckets[bucketIdx].feesA += feeAmount;
            } else {
                buckets[bucketIdx].volumeB += amountIn;
                buckets[bucketIdx].feesB += feeAmount;
            }
        }
        // Format output
        const timeSeries = buckets.map(b => ({
            timestamp: b.timestamp,
            volumeA: b.volumeA.toString(),
            volumeB: b.volumeB.toString(),
            feesA: b.feesA.toString(),
            feesB: b.feesB.toString()
        }));
        return res.json({
            poolId,
            period,
            interval,
            from: startTime.toISOString(),
            to: now.toISOString(),
            timeSeries
        });
    } catch (error: any) {
        logger.error(`Error fetching analytics for pool ${poolId}:`, error);
        res.status(500).json({ message: 'Error fetching pool analytics', error: error.message });
    }
}) as RequestHandler);

export default router;