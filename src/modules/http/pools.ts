import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt, toString as bigintToString, parseTokenAmount } from '../../utils/bigint-utils.js';
import { getTokenDecimals } from '../../utils/bigint-utils.js';
import { formatTokenAmountForResponse, formatTokenAmountSimple } from '../../utils/http-helpers.js';

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
        // LP tokens don't have a specific symbol, so we'll format them as raw values
        const lpTokensBigInt = toBigInt(transformed.totalLpTokens);
        transformed.totalLpTokens = lpTokensBigInt.toString();
        transformed.rawTotalLpTokens = lpTokensBigInt.toString();
    }

    return transformed;
};

const transformUserLiquidityPositionData = (positionData: any): any => {
    if (!positionData) return positionData;
    const transformed = { ...positionData };
    transformed.id = transformed._id.toString();
    if (transformed._id && transformed.id !== transformed._id) delete transformed._id;

    // Format LP token balance
    if (transformed.lpTokenBalance) {
        // LP tokens don't have a specific symbol, so we'll format them as raw values
        const lpBalanceBigInt = toBigInt(transformed.lpTokenBalance);
        transformed.lpTokenBalance = lpBalanceBigInt.toString();
        transformed.rawLpTokenBalance = lpBalanceBigInt.toString();
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
                finalAmountInFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountIn), fromTokenSymbol),
                finalAmountOutFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountOut), toTokenSymbol),
                hops: route.hops.map(hop => ({
                    ...hop,
                    amountIn: toBigInt(hop.amountIn).toString(),
                    amountOut: toBigInt(hop.amountOut).toString(),
                    amountInFormatted: formatTokenAmountSimple(toBigInt(hop.amountIn), hop.tokenIn),
                    amountOutFormatted: formatTokenAmountSimple(toBigInt(hop.amountOut), hop.tokenOut),
                }))
            };
        };

        res.json({ bestRoute: transformRouteForAPI(bestRoute), allRoutes: routes.map(transformRouteForAPI) });
    } catch (error: any) {
        logger.error(`Error finding swap route for ${fromTokenSymbol}->${toTokenSymbol}:`, error);
        res.status(500).json({ message: 'Error finding swap route', error: error.message });
    }
}) as RequestHandler);

// POST /pools/autoSwapRoute - Execute automatic swap using best route
router.post('/autoSwapRoute', (async (req: Request, res: Response) => {
    const { tokenIn, tokenOut, amountIn, slippage } = req.body;

    if (!tokenIn || !tokenOut || !amountIn) {
        return res.status(400).json({ message: 'Missing required body parameters: tokenIn, tokenOut, amountIn.' });
    }
    if (typeof tokenIn !== 'string' || typeof tokenOut !== 'string') {
        return res.status(400).json({ message: 'tokenIn and tokenOut must be strings.' });
    }
    if (typeof amountIn !== 'number' && typeof amountIn !== 'string') {
        return res.status(400).json({ message: 'amountIn must be a number or string.' });
    }

    // Default slippage to 0.5% if not provided
    const slippagePercent = slippage !== undefined ? Number(slippage) : 0.5;
    if (slippagePercent < 0 || slippagePercent > 100) {
        return res.status(400).json({ message: 'Slippage must be between 0 and 100 percent.' });
    }

    if (tokenIn === tokenOut) {
        return res.status(400).json({ message: 'Input and output tokens cannot be the same.' });
    }

    let amountInBigInt: bigint;
    try {
        // Convert input amount to smallest unit BigInt
        const amountInStr = typeof amountIn === 'number' ? amountIn.toString() : amountIn;
        amountInBigInt = parseTokenAmount(amountInStr, tokenIn);
        if (amountInBigInt <= 0n) {
            return res.status(400).json({ message: `Invalid amountIn: ${amountIn}. Must result in a positive value in smallest units.` });
        }
    } catch (error: any) {
        logger.error(`Error parsing amountIn for auto swap: ${amountIn}, token: ${tokenIn}`, error);
        return res.status(400).json({ 
            message: `Invalid amountIn '${amountIn}' for token '${tokenIn}'. Error: ${error.message}`,
            error: error.message 
        });
    }

    try {
        // Find the best route
        const amountInSmallestUnitStr = bigintToString(amountInBigInt);
        const routes: TradeRoute[] = await findAllTradeRoutesBigInt(
            tokenIn,
            tokenOut,
            amountInSmallestUnitStr
        );

        if (!routes || routes.length === 0) {
            return res.status(404).json({ message: 'No trade route found.' });
        }

        const bestRoute = routes[0];
        
        // Define the transform function for API responses
        const transformRouteForAPI = (route: TradeRoute): any => {
            return {
                ...route,
                finalAmountIn: toBigInt(route.finalAmountIn).toString(),
                finalAmountOut: toBigInt(route.finalAmountOut).toString(),
                finalAmountInFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountIn), tokenIn),
                finalAmountOutFormatted: formatTokenAmountSimple(toBigInt(route.finalAmountOut), tokenOut),
                hops: route.hops.map(hop => ({
                    ...hop,
                    amountIn: toBigInt(hop.amountIn).toString(),
                    amountOut: toBigInt(hop.amountOut).toString(),
                    amountInFormatted: formatTokenAmountSimple(toBigInt(hop.amountIn), hop.tokenIn),
                    amountOutFormatted: formatTokenAmountSimple(toBigInt(hop.amountOut), hop.tokenOut),
                }))
            };
        };
        
        // Execute the swap using the best route
        // For now, we'll execute the first hop (direct swap)
        // In the future, this could be extended to handle multi-hop routes
        if (bestRoute.hops.length === 1) {
            const hop = bestRoute.hops[0];
            
            // For now, we'll use a placeholder trader since this is an HTTP API
            // In a real implementation, this would come from authentication headers
            const trader = 'auto_swap_user'; // TODO: Get from auth headers
            
            // Calculate minimum amount out based on slippage
            // Use a more conservative approach to account for potential price changes
            const expectedAmountOut = toBigInt(hop.amountOut);
            const slippageMultiplier = BigInt(10000 - Math.floor(slippagePercent * 100)); // e.g., 9950 for 0.5% slippage
            const minAmountOut = (expectedAmountOut * slippageMultiplier) / BigInt(10000);
            
            // Create swap transaction data
            const swapData = {
                poolId: hop.poolId,
                trader: trader,
                tokenIn_symbol: hop.tokenIn,
                tokenOut_symbol: hop.tokenOut,
                amountIn: hop.amountIn,
                minAmountOut: bigintToString(minAmountOut)
            };

            // Import the swap processing function
            const { process: processSwap } = await import('../../transactions/pool/pool-swap.js');
            
            // Generate a transaction ID
            const transactionId = `auto_swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Execute the swap
            const swapSuccess = await processSwap(swapData, trader, transactionId);
            
            if (swapSuccess) {
                res.json({
                    success: true,
                    message: 'Swap executed successfully',
                    transactionId: transactionId,
                    route: transformRouteForAPI(bestRoute),
                    executedAmountIn: formatTokenAmountSimple(amountInBigInt, tokenIn),
                    executedAmountOut: formatTokenAmountSimple(toBigInt(bestRoute.finalAmountOut), tokenOut)
                });
            } else {
                res.status(500).json({ 
                    success: false,
                    message: 'Swap execution failed',
                    route: transformRouteForAPI(bestRoute)
                });
            }
        } else {
            // Multi-hop routes not yet implemented
            res.status(501).json({ 
                success: false,
                message: 'Multi-hop routes not yet supported in auto swap',
                route: transformRouteForAPI(bestRoute)
            });
        }
    } catch (error: any) {
        logger.error(`Error executing auto swap for ${tokenIn}->${tokenOut}:`, error);
        res.status(500).json({ 
            success: false,
            message: 'Error executing auto swap', 
            error: error.message 
        });
    }
}) as RequestHandler);

export default router;