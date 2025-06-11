import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt, toString as bigintToString, parseTokenAmount } from '../../utils/bigint-utils.js';
import { getTokenDecimals } from '../../utils/bigint-utils.js';

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
    feeRateBasisPoints: bigint; // e.g., 30n for 0.3% (30 / 10000)
    precisionFactor?: bigint; // e.g. 10n**18n for precision in intermediate calcs, if needed
}

interface TradeHop {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string; // Padded BigInt string, for this specific hop
    amountOut: string; // Padded BigInt string, for this specific hop
}

interface TradeRoute {
    hops: TradeHop[];
    finalAmountIn: string; // Padded BigInt string (initial amount for the whole route)
    finalAmountOut: string; // Padded BigInt string (final amount out for the whole route)
}

// --- Helper Functions for Swap Routing (REWRITTEN for BigInt) ---

const BASIS_POINTS_DENOMINATOR = 10000n;

/**
 * Calculates the output amount for a single swap in a pool using BigInt.
 * Assumes fee is taken from the input amount.
 * Formula: outputAmount = (inputAmountAfterFee * outputReserve) / (inputReserve + inputAmountAfterFee)
 */
function getOutputAmountBigInt(
    inputAmount: bigint,
    inputReserve: bigint,
    outputReserve: bigint,
    feeRateBasisPoints: bigint // e.g., 30n for 0.3%
): bigint {
    if (inputAmount <= 0n || inputReserve <= 0n || outputReserve <= 0n) {
        return 0n;
    }
    // Fee calculation: fee = (inputAmount * feeRateBasisPoints) / BASIS_POINTS_DENOMINATOR
    const fee = (inputAmount * feeRateBasisPoints) / BASIS_POINTS_DENOMINATOR;
    const inputAmountAfterFee = inputAmount - fee;

    if (inputAmountAfterFee <= 0n) return 0n;

    const numerator = inputAmountAfterFee * outputReserve;
    const denominator = inputReserve + inputAmountAfterFee;
    
    if (denominator === 0n) return 0n; // Avoid division by zero
    return numerator / denominator; // BigInt division naturally truncates
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
        feeRateBasisPoints: BigInt(p.feeRateBasisPoints || 30),
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
            
            const amountOutFromHopBigInt = getOutputAmountBigInt( currentAmountInBigInt, tokenInReserveBigInt, tokenOutReserveBigInt, pool.feeRateBasisPoints );
            if (amountOutFromHopBigInt <= 0n) continue;
            
            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentTokenSymbol,
                tokenOut: nextTokenSymbol,
                amountIn: bigintToString(currentAmountInBigInt),
                amountOut: bigintToString(amountOutFromHopBigInt)
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
    // _id for pools is likely string (e.g. TOKENA-TOKENB), ensure it's id or keep as _id.
    // For this example, let's assume it is already a string and doesn't need ObjectId conversion.
    // If it can be ObjectId: if (transformed._id && typeof transformed._id !== 'string') { transformed.id = transformed._id.toString(); delete transformed._id; }
    transformed.id = transformed._id.toString(); // Assuming _id is present and can be stringified.
    if (transformed._id && transformed.id !== transformed._id) delete transformed._id;

    const numericFields = ['tokenA_reserve', 'tokenB_reserve', 'totalLiquidity', 'volume24h', 'totalFeesEarned', 'feeRateBasisPoints'];
    for (const field of numericFields) {
        if (transformed[field]) {
            if (typeof transformed[field] === 'bigint') {
                 transformed[field] = bigintToString(transformed[field]); // Use padded toString for bigint
            } else if (typeof transformed[field] === 'string') {
                // If it's already a string from DB, assume it's correctly padded (or unpad then re-pad if needed)
                // For API output, we just want unpadded string version from the BigInt value.
                try { transformed[field] = toBigInt(transformed[field]).toString(); } catch (e) { /* keep as is if not valid bigint string */ }
            } else if (typeof transformed[field] === 'number'){ // For fields like feeRate that might be numbers
                 transformed[field] = transformed[field].toString();
            }
        }
    }
    return transformed;
};

const transformUserLiquidityPositionData = (positionData: any): any => {
    if (!positionData) return positionData;
    const transformed = { ...positionData };
    // _id for userLiquidityPositions is typically a string like `userId-poolId`.
    transformed.id = transformed._id.toString();
    if (transformed._id && transformed.id !== transformed._id) delete transformed._id;

    const numericFields = ['liquidityTokensOwned', 'tokenA_provided', 'tokenB_provided', 'feesEarnedTokenA', 'feesEarnedTokenB'];
    for (const field of numericFields) {
        if (transformed[field] && typeof transformed[field] === 'string') {
             try { transformed[field] = toBigInt(transformed[field]).toString(); } catch (e) { /* keep as is */ }
        }
    }
    return transformed;
};

// --- Liquidity Pools ---
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const poolsFromDB = await cache.findPromise('liquidityPools', {}, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('liquidityPools').countDocuments({});
        const pools = (poolsFromDB || []).map(transformPoolData);
        res.json({ data: pools, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching liquidity pools:', error);
        res.status(500).json({ message: 'Error fetching liquidity pools', error: error.message });
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
        const positionsFromDB = await cache.findPromise('userLiquidityPositions', { provider: userId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userLiquidityPositions').countDocuments({ provider: userId });
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

// Get specific position by its composite ID (provider-poolId)
router.get('/positions/:positionId', (async (req: Request, res: Response) => {
    const { positionId } = req.params;
    try {
        const positionFromDB = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `Liquidity position ${positionId} not found.` });
        }
        res.json(transformUserLiquidityPositionData(positionFromDB));
    } catch (error: any) {
        logger.error(`Error fetching liquidity position ${positionId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity position', error: error.message });
    }
}) as RequestHandler);

// Get a specific user's liquidity position in a specific pool
router.get('/positions/user/:userId/pool/:poolId', (async (req: Request, res: Response) => {
    const { userId, poolId } = req.params;
    const positionId = `${userId}-${poolId}`;
    try {
        const positionFromDB = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `Liquidity position for user ${userId} in pool ${poolId} not found.` });
        }
        res.json(transformUserLiquidityPositionData(positionFromDB));
    } catch (error: any) {
        logger.error(`Error fetching position for user ${userId} in pool ${poolId}:`, error);
        res.status(500).json({ message: 'Error fetching user liquidity position in pool', error: error.message });
    }
}) as RequestHandler);

// GET /pools/route-swap - Find the best swap route
router.get('/route-swap', (async (req: Request, res: Response) => {
    const { fromTokenSymbol, toTokenSymbol, amountIn } = req.query;

    if (!fromTokenSymbol || !toTokenSymbol || !amountIn) {
        return res.status(400).json({ message: 'Missing required query parameters: fromTokenSymbol, toTokenSymbol, amountIn.' });
    }
    if (typeof fromTokenSymbol !== 'string' || typeof toTokenSymbol !== 'string' || typeof amountIn !== 'string') {
        return res.status(400).json({ message: 'Query parameters must be strings.' });
    }

    if (fromTokenSymbol === toTokenSymbol) {
        return res.status(400).json({ message: 'Input and output tokens cannot be the same.' });
    }

    let amountInBigInt: bigint;
    try {
        // Convert input amount (e.g., "1.23") to smallest unit BigInt (e.g., 123000000n)
        amountInBigInt = parseTokenAmount(amountIn, fromTokenSymbol);
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
            return {
                ...route,
                finalAmountIn: toBigInt(route.finalAmountIn).toString(),
                finalAmountOut: toBigInt(route.finalAmountOut).toString(),
                hops: route.hops.map(hop => ({
                    ...hop,
                    amountIn: toBigInt(hop.amountIn).toString(),
                    amountOut: toBigInt(hop.amountOut).toString(),
                }))
            };
        };

        res.json({ bestRoute: transformRouteForAPI(bestRoute), allRoutes: routes.map(transformRouteForAPI) });
    } catch (error: any) {
        logger.error(`Error finding swap route for ${fromTokenSymbol}->${toTokenSymbol}:`, error);
        res.status(500).json({ message: 'Error finding swap route', error: error.message });
    }
}) as RequestHandler);

export default router; 