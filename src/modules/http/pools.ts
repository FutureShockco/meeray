import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// --- Types for Swap Routing ---
interface Pool {
    _id: string;
    tokenA_symbol: string;
    tokenA_reserve: number;
    tokenB_symbol: string;
    tokenB_reserve: number;
    feeRate: number; // e.g., 0.003 for 0.3%
}

interface TradeHop {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountOut: number;
}

interface TradeRoute {
    hops: TradeHop[];
    totalAmountOut: number;
}

// --- Helper Functions for Swap Routing ---

/**
 * Calculates the output amount for a single swap in a pool.
 * Assumes fee is taken from the input amount.
 * Formula: outputAmount = (inputAmount * (1 - feeRate) * outputReserve) / (inputReserve + inputAmount * (1 - feeRate))
 */
function getOutputAmount(
    inputAmount: number,
    inputReserve: number,
    outputReserve: number,
    feeRate: number
): number {
    if (inputAmount <= 0 || inputReserve <= 0 || outputReserve <= 0) {
        return 0;
    }
    const inputAmountAfterFee = inputAmount * (1 - feeRate);
    const numerator = inputAmountAfterFee * outputReserve;
    const denominator = inputReserve + inputAmountAfterFee;
    if (denominator === 0) return 0; // Avoid division by zero
    return numerator / denominator;
}

/**
 * Finds all possible trade routes from a start token to an end token.
 */
async function findAllTradeRoutes(
    startToken: string,
    endToken: string,
    initialAmountIn: number,
    maxHops: number = 4
): Promise<TradeRoute[]> {
    const allPools: Pool[] = await mongo.getDb().collection<Pool>('pools').find({}).toArray();
    const routes: TradeRoute[] = [];
    
    // Queue for BFS: [currentToken, currentPathHops, currentAmountOutSoFar]
    const queue: [string, TradeHop[], number][] = [[startToken, [], initialAmountIn]];
    
    while (queue.length > 0) {
        const [currentToken, currentPath, currentAmountIn] = queue.shift()!;
        
        if (currentPath.length >= maxHops) {
            continue;
        }
        
        for (const pool of allPools) {
            let tokenInReserve: number, tokenOutReserve: number, nextToken: string;
            
            if (pool.tokenA_symbol === currentToken && pool.tokenB_reserve > 0 && pool.tokenA_reserve > 0) {
                tokenInReserve = pool.tokenA_reserve;
                tokenOutReserve = pool.tokenB_reserve;
                nextToken = pool.tokenB_symbol;
            } else if (pool.tokenB_symbol === currentToken && pool.tokenA_reserve > 0 && pool.tokenB_reserve > 0) {
                tokenInReserve = pool.tokenB_reserve;
                tokenOutReserve = pool.tokenA_reserve;
                nextToken = pool.tokenA_symbol;
            } else {
                continue; // Pool doesn't involve currentToken or has no reserves
            }

            // Avoid swapping back to the token we just came from in the current path
            if (currentPath.length > 0 && currentPath[currentPath.length -1].tokenIn === nextToken) {
                continue;
            }
            
            const amountOutFromHop = getOutputAmount(currentAmountIn, tokenInReserve, tokenOutReserve, pool.feeRate);
            
            if (amountOutFromHop <= 0) {
                continue;
            }
            
            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentToken,
                tokenOut: nextToken,
                amountOut: amountOutFromHop
            };
            const newPath = [...currentPath, newHop];
            
            if (nextToken === endToken) {
                routes.push({ hops: newPath, totalAmountOut: amountOutFromHop });
            } else {
                queue.push([nextToken, newPath, amountOutFromHop]);
            }
        }
    }
    return routes;
}

// --- Liquidity Pools ---
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const pools = await cache.findPromise('pools', {}, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('pools').countDocuments({});
        res.json({ data: pools, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching liquidity pools:', error);
        res.status(500).json({ message: 'Error fetching liquidity pools', error: error.message });
    }
}) as RequestHandler);

router.get('/:poolId', (async (req: Request, res: Response) => {
    const { poolId } = req.params;
    try {
        const pool = await cache.findOnePromise('pools', { _id: poolId });
        if (!pool) {
            return res.status(404).json({ message: `Liquidity pool ${poolId} not found.` });
        }
        res.json(pool);
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
        const pools = await cache.findPromise('pools', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('pools').countDocuments(query);
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
        // Assuming 'provider' is the field for user ID in userLiquidityPositions
        const positions = await cache.findPromise('userLiquidityPositions', { provider: userId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userLiquidityPositions').countDocuments({ provider: userId });
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
        const positions = await cache.findPromise('userLiquidityPositions', { poolId: poolId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userLiquidityPositions').countDocuments({ poolId: poolId });
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
        const position = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!position) {
            return res.status(404).json({ message: `Liquidity position ${positionId} not found.` });
        }
        res.json(position);
    } catch (error: any) {
        logger.error(`Error fetching liquidity position ${positionId}:`, error);
        res.status(500).json({ message: 'Error fetching liquidity position', error: error.message });
    }
}) as RequestHandler);

// Get a specific user's liquidity position in a specific pool
router.get('/positions/user/:userId/pool/:poolId', (async (req: Request, res: Response) => {
    const { userId, poolId } = req.params;
    const positionId = `${userId}-${poolId}`; // Construct the _id for userLiquidityPositions
    try {
        const position = await cache.findOnePromise('userLiquidityPositions', { _id: positionId });
        if (!position) {
            return res.status(404).json({ message: `Liquidity position for user ${userId} in pool ${poolId} not found.` });
        }
        res.json(position);
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

    if (fromTokenSymbol === toTokenSymbol) {
        return res.status(400).json({ message: 'Input and output tokens cannot be the same.' });
    }

    const parsedAmountIn = parseFloat(amountIn as string);
    if (isNaN(parsedAmountIn) || parsedAmountIn <= 0) {
        return res.status(400).json({ message: 'Invalid amountIn. Must be a positive number.' });
    }

    try {
        const routes = await findAllTradeRoutes(
            fromTokenSymbol as string,
            toTokenSymbol as string,
            parsedAmountIn
        );

        if (routes.length === 0) {
            return res.status(404).json({ 
                message: `No viable trade route found from ${fromTokenSymbol} to ${toTokenSymbol}.`,
                fromTokenSymbol,
                toTokenSymbol,
                amountIn: parsedAmountIn
            });
        }

        // Find the route with the best (highest) totalAmountOut
        const bestRoute = routes.reduce((prev, current) => 
            (prev.totalAmountOut > current.totalAmountOut) ? prev : current
        );
        
        res.json({
            success: true,
            fromTokenSymbol,
            toTokenSymbol,
            amountIn: parsedAmountIn,
            bestRoute
        });

    } catch (error: any) {
        logger.error(`Error finding swap route for ${fromTokenSymbol}->${toTokenSymbol}:`, error);
        res.status(500).json({ message: 'Error finding swap route', error: error.message });
    }
}) as RequestHandler);

export default router; 