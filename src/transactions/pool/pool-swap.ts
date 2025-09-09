import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, LiquidityPoolData, PoolSwapResult } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import mongo from '../../mongo.js';
import { logEvent } from '../../utils/event-logger.js';

// const SWAP_FEE_RATE = 0.003; // 0.3% swap fee - This constant is not used in the BigInt logic below which uses 997/1000 factor

const NUMERIC_FIELDS_SWAP: Array<keyof PoolSwapData> = ['amountIn', 'minAmountOut'];

// Route finding interfaces
interface TradeHop {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    priceImpact: number;
}

interface TradeRoute {
    hops: TradeHop[];
    finalAmountIn: string;
    finalAmountOut: string;
}

interface Pool {
    _id: string;
    tokenA_symbol: string;
    tokenA_reserve: string;
    tokenB_symbol: string;
    tokenB_reserve: string;
    // Note: Fee is always 0.3% (300 basis points) - no longer stored per pool
}

/**
 * Calculates the output amount for a swap using the constant product formula
 * This matches the exact logic used in the HTTP route-swap API
 * 
 * IMPORTANT: This function uses the same calculation as src/modules/http/pools.ts:getOutputAmountBigInt
 * Any changes to the calculation logic must be made in both places to maintain consistency.
 */
function getOutputAmountBigInt(
    inputAmount: bigint,
    inputReserve: bigint,
    outputReserve: bigint
): bigint {
    if (inputAmount <= 0n || inputReserve <= 0n || outputReserve <= 0n) {
        return 0n;
    }

    // Use fixed 0.3% fee tier (300 basis points)
    const feeTier = 300;
    const feeMultiplier = BigInt(10000) - BigInt(feeTier); // 10000 - 300 = 9700 for 0.3% fee
    const feeDivisor = BigInt(10000);

    const amountInAfterFee = (inputAmount * feeMultiplier) / feeDivisor; // Use BigInt division like HTTP API

    if (amountInAfterFee <= 0n) return 0n;

    const numerator = amountInAfterFee * outputReserve;
    const denominator = inputReserve + amountInAfterFee;
    
    if (denominator === 0n) return 0n; // Avoid division by zero
    return numerator / denominator; // BigInt division naturally truncates
}

/**
 * Calculates the price impact of a swap
 */
function calculatePriceImpact(amountIn: bigint, reserveIn: bigint): number {
    if (amountIn <= 0n || reserveIn <= 0n) {
        return 0;
    }

    const totalReserveAfterSwap = reserveIn + amountIn;
    const priceImpactBasisPoints = Number((amountIn * BigInt(10000)) / totalReserveAfterSwap);

    return priceImpactBasisPoints / 100;
}

/**
 * Finds the best trade route from start token to end token
 */
async function findBestTradeRoute(
    startTokenSymbol: string,
    endTokenSymbol: string,
    initialAmountIn: bigint,
    maxHops: number = 3
): Promise<TradeRoute | null> {
    const allPoolsFromDB: any[] = await mongo.getDb().collection('liquidityPools').find({}).toArray();
    const allPools: Pool[] = allPoolsFromDB.map(p => ({
        _id: p._id.toString(),
        tokenA_symbol: p.tokenA_symbol,
        tokenA_reserve: p.tokenA_reserve,
        tokenB_symbol: p.tokenB_symbol,
        tokenB_reserve: p.tokenB_reserve,
        feeTier: 300 // Fixed 0.3% fee
    }));

    const routes: TradeRoute[] = [];
    const queue: [string, TradeHop[], bigint][] = [[startTokenSymbol, [], initialAmountIn]];

    while (queue.length > 0) {
        const [currentTokenSymbol, currentPath, currentAmountIn] = queue.shift()!;
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

            const tokenInReserve = toBigInt(tokenInReserveStr);
            const tokenOutReserve = toBigInt(tokenOutReserveStr);
            if (tokenInReserve <= 0n || tokenOutReserve <= 0n) continue;
            if (currentPath.length > 0 && currentPath[currentPath.length - 1].tokenIn === nextTokenSymbol) continue;

            const amountOutFromHop = getOutputAmountBigInt(currentAmountIn, tokenInReserve, tokenOutReserve);
            if (amountOutFromHop <= 0n) continue;

            const priceImpact = calculatePriceImpact(currentAmountIn, tokenInReserve);

            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentTokenSymbol,
                tokenOut: nextTokenSymbol,
                amountIn: currentAmountIn.toString(),
                amountOut: amountOutFromHop.toString(),
                priceImpact: priceImpact
            };
            const newPath = [...currentPath, newHop];

            if (nextTokenSymbol === endTokenSymbol) {
                routes.push({
                    hops: newPath,
                    finalAmountIn: initialAmountIn.toString(),
                    finalAmountOut: amountOutFromHop.toString()
                });
            } else {
                queue.push([nextTokenSymbol, newPath, amountOutFromHop]);
            }
        }
    }

    // Return the best route (highest output amount)
    return routes.sort((a, b) => toBigInt(b.finalAmountOut) > toBigInt(a.finalAmountOut) ? 1 : -1)[0] || null;
}

export async function validateTx(data: PoolSwapData, sender: string): Promise<boolean> {
    try {
        if (toBigInt(data.amountIn) <= 0n) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return false;
        }

        if (data.minAmountOut !== undefined && toBigInt(data.minAmountOut) <= 0n) {
            logger.warn('[pool-swap] minAmountOut, if provided, must be a positive BigInt.');
            return false;
        }
        if (data.slippagePercent !== undefined) {
            if (typeof data.slippagePercent !== 'number' || isNaN(data.slippagePercent)) {
                logger.warn('[pool-swap] slippagePercent must be a valid number.');
                return false;
            }
            if (data.slippagePercent < 0 || data.slippagePercent > 100) {
                logger.warn('[pool-swap] slippagePercent must be between 0 and 100 percent.');
                return false;
            }
        } else {
            // Require slippagePercent for auto-route swaps
            logger.warn('[pool-swap] slippagePercent is required for auto-route swaps.');
            return false;

        }

        const traderAccount = await getAccount(sender);
        if (!traderAccount) {
            logger.warn(`[pool-swap] Trader account ${sender} not found.`);
            return false;
        }

        // Check if this is a routed swap or single-hop swap
        if (data.hops && data.hops.length > 0) {
            // Multi-hop routed swap
            return await validateRoutedSwap(data, sender, traderAccount);
        } else if (data.poolId) {
            // Single-hop swap
            return await validateSingleHopSwap(data, sender, traderAccount);
        } else if (data.fromTokenSymbol && data.toTokenSymbol) {
            // Auto-route swap - find the best route
            return await validateAutoRouteSwap(data, sender, traderAccount);
        } else {
            logger.warn('[pool-swap] Invalid swap data: must specify either poolId for single-hop, hops for multi-hop, or fromTokenSymbol/toTokenSymbol for auto-routing.');
            return false;
        }
    } catch (error) {
        logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
        return false;
    }
}

async function validateSingleHopSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
    // Get pool data
    const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: data.poolId }))!;
    if (!poolFromDb) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found.`);
        return false;
    }

    // Verify token symbols match
    if (!((poolFromDb.tokenA_symbol === data.tokenIn_symbol && poolFromDb.tokenB_symbol === data.tokenOut_symbol) ||
        (poolFromDb.tokenB_symbol === data.tokenIn_symbol && poolFromDb.tokenA_symbol === data.tokenOut_symbol))) {
        logger.warn('[pool-swap] Token symbols do not match pool configuration.');
        return false;
    }

    // Check pool liquidity
    if (toBigInt(poolFromDb.tokenA_reserve) <= 0n || toBigInt(poolFromDb.tokenB_reserve) <= 0n) {
        logger.warn(`[pool-swap] Pool ${data.poolId} has insufficient liquidity.`);
        return false;
    }

    // Check trader balance
    const tokenInIdentifier = data.tokenIn_symbol;
    const traderBalance = toBigInt(traderAccount.balances?.[tokenInIdentifier] || '0');
    if (traderBalance < toBigInt(data.amountIn)) {
        logger.warn(`[pool-swap] Insufficient balance for ${tokenInIdentifier}. Has ${traderBalance}, needs ${data.amountIn}`);
        return false;
    }

    return true;
}

async function validateRoutedSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
    // Validate each hop using the same calculation logic as execution
    let currentAmountIn = data.amountIn;
    for (let i = 0; i < data.hops!.length; i++) {
        const hop = data.hops![i];
        
        // Get pool data for this hop
        const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: hop.poolId }))!;
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} not found for hop ${i + 1}.`);
            return false;
        }

        // Verify token symbols match for this hop
        if (!((poolFromDb.tokenA_symbol === hop.tokenIn_symbol && poolFromDb.tokenB_symbol === hop.tokenOut_symbol) ||
              (poolFromDb.tokenB_symbol === hop.tokenIn_symbol && poolFromDb.tokenA_symbol === hop.tokenOut_symbol))) {
            logger.warn(`[pool-swap] Token symbols do not match pool configuration for hop ${i + 1}.`);
            return false;
        }

        // Check pool liquidity
        if (toBigInt(poolFromDb.tokenA_reserve) <= 0n || toBigInt(poolFromDb.tokenB_reserve) <= 0n) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} has insufficient liquidity for hop ${i + 1}.`);
            return false;
        }

        // Calculate actual output for this hop (same as HTTP API)
        const tokenInIsA = hop.tokenIn_symbol === poolFromDb.tokenA_symbol;
        const reserveIn = tokenInIsA ? toBigInt(poolFromDb.tokenA_reserve) : toBigInt(poolFromDb.tokenB_reserve);
        const reserveOut = tokenInIsA ? toBigInt(poolFromDb.tokenB_reserve) : toBigInt(poolFromDb.tokenA_reserve);

        const amountOut = getOutputAmountBigInt(toBigInt(currentAmountIn), reserveIn, reserveOut);

        // Check if actual calculation meets minimum (same as execution)
        if (hop.minAmountOut && amountOut < toBigInt(hop.minAmountOut)) {
            logger.warn(`[pool-swap] Validation: Output amount ${amountOut} is less than minimum required ${hop.minAmountOut} for hop ${i + 1}.`);
            return false;
        }

        // Update for next hop
        currentAmountIn = amountOut;
    }

    // Check final minimum output
    if (data.minAmountOut && toBigInt(currentAmountIn) < toBigInt(data.minAmountOut)) {
        logger.warn(`[pool-swap] Validation: Final output amount ${currentAmountIn} is less than minimum required ${data.minAmountOut}.`);
        return false;
    }

    // Check initial balance (only need to check the first token)
    const initialTokenSymbol = data.hops![0].tokenIn_symbol;
    const traderBalance = toBigInt(traderAccount.balances?.[initialTokenSymbol] || '0');
    if (traderBalance < toBigInt(data.amountIn)) {
        logger.warn(`[pool-swap] Insufficient balance for ${initialTokenSymbol}. Has ${traderBalance}, needs ${data.amountIn}`);
        return false;
    }

    return true;
}

async function validateAutoRouteSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
    // Find the best route
    const bestRoute = await findBestTradeRoute(data.fromTokenSymbol!, data.toTokenSymbol!, toBigInt(data.amountIn));
    if (!bestRoute) {
        logger.warn(`[pool-swap] No route found from ${data.fromTokenSymbol} to ${data.toTokenSymbol}.`);
        return false;
    }

    // Apply slippage tolerance (same logic as execution)
    const slippagePercent = data.slippagePercent || 1.0;
    const expectedFinalOutput = toBigInt(bestRoute.finalAmountOut);
    
    // Calculate minimum output (same logic as execution)
    const finalMinAmountOut = data.minAmountOut || 
        (expectedFinalOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

    // Validate each hop using the same calculation logic as execution
    let currentAmountIn = toBigInt(data.amountIn);
    for (let i = 0; i < bestRoute.hops.length; i++) {
        const hop = bestRoute.hops[i];
        
        // Get current pool data (same as execution)
        const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: hop.poolId })) as { tokenA_symbol: string; tokenA_reserve: string; tokenB_symbol: string; tokenB_reserve: string; feeTier: number };
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} not found during validation for hop ${i + 1}.`);
            return false;
        }

        // Determine token indices (same as execution)
        const tokenInIsA = hop.tokenIn === poolFromDb.tokenA_symbol;
        const reserveIn = tokenInIsA ? toBigInt(poolFromDb.tokenA_reserve) : toBigInt(poolFromDb.tokenB_reserve);
        const reserveOut = tokenInIsA ? toBigInt(poolFromDb.tokenB_reserve) : toBigInt(poolFromDb.tokenA_reserve);

        // Calculate output amount using the same formula as HTTP API
        const amountOut = getOutputAmountBigInt(currentAmountIn, reserveIn, reserveOut);

        // Calculate minimum for this hop (same as execution)
        const expectedOutput = toBigInt(hop.amountOut);
        const hopMinAmountOut = (expectedOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

        // Check if actual calculation meets minimum (same as execution)
        if (amountOut < hopMinAmountOut) {
            logger.warn(`[pool-swap] Validation: Output amount ${amountOut} is less than minimum required ${hopMinAmountOut} for hop ${i + 1}.`);
            return false;
        }

        // Update for next hop
        currentAmountIn = amountOut;
    }

    // Check final minimum output
    if (data.minAmountOut && currentAmountIn < toBigInt(data.minAmountOut)) {
        logger.warn(`[pool-swap] Validation: Final output amount ${currentAmountIn} is less than minimum required ${data.minAmountOut}.`);
        return false;
    }

    // Check initial balance
    const traderBalance = toBigInt(traderAccount.balances?.[data.fromTokenSymbol!] || '0');
    if (traderBalance < toBigInt(data.amountIn)) {
        logger.warn(`[pool-swap] Insufficient balance for ${data.fromTokenSymbol}. Has ${traderBalance}, needs ${data.amountIn}`);
        return false;
    }

    return true;
}

export async function process(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Determine the type of swap and process accordingly
    if (data.hops && data.hops.length > 0) {
        // Multi-hop routed swap
        return await processRoutedSwap(data, sender, transactionId);
    } else if (data.poolId) {
        // Single-hop swap
        return await processSingleHopSwap(data, sender, transactionId);
    } else if (data.fromTokenSymbol && data.toTokenSymbol) {
        // Auto-route swap
        return await processAutoRouteSwap(data, sender, transactionId);
    } else {
        logger.error('[pool-swap] Invalid swap data: must specify either poolId, hops, or fromTokenSymbol/toTokenSymbol.');
        return false;
    }
}

/**
 * Process swap and return detailed result including output amount
 * This is used by the hybrid trading system
 */
export async function processWithResult(data: PoolSwapData, sender: string, transactionId: string): Promise<PoolSwapResult> {
    try {
        // For now, only support single-hop swaps in hybrid trading
        if (data.poolId) {
            return await processSingleHopSwapWithResult(data, sender, transactionId);
        } else {
            return { success: false, amountOut: BigInt(0), error: 'Only single-hop swaps supported in hybrid trading' };
        }
    } catch (error) {
        return { success: false, amountOut: BigInt(0), error: `Swap error: ${error}` };
    }
}

async function processSingleHopSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Get pool data
    const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as any; // validateTx ensures existence

    // Determine token indices
    const tokenInIsA = data.tokenIn_symbol === poolFromDb.tokenA_symbol;
    const tokenIn_symbol = tokenInIsA ? poolFromDb.tokenA_symbol : poolFromDb.tokenB_symbol;
    const tokenOut_symbol = tokenInIsA ? poolFromDb.tokenB_symbol : poolFromDb.tokenA_symbol;
    const reserveIn = tokenInIsA ? toBigInt(poolFromDb.tokenA_reserve) : toBigInt(poolFromDb.tokenB_reserve);
    const reserveOut = tokenInIsA ? toBigInt(poolFromDb.tokenB_reserve) : toBigInt(poolFromDb.tokenA_reserve);

    // Calculate output amount using constant product formula (same as HTTP API)
    const amountOut = getOutputAmountBigInt(toBigInt(data.amountIn), reserveIn, reserveOut);

    // Calculate fee amount and update feeGrowthGlobal
    const feeDivisor = BigInt(10000);
    const feeAmount = (toBigInt(data.amountIn) * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
    const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
    let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
    let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');
    
    if (totalLpTokens > 0n && feeAmount > 0n) {
        const feeGrowthDelta = (feeAmount * BigInt(1e18)) / totalLpTokens;
        if (tokenInIsA) {
            newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
        } else {
            newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
        }
    }

    // Ensure minimum output amount is met
    if (data.minAmountOut && amountOut < toBigInt(data.minAmountOut)) {
        logger.warn(`[pool-swap] Output amount ${amountOut} is less than minimum required ${data.minAmountOut}.`);
        return false;
    }

    // Update pool reserves
    const newReserveIn = reserveIn + toBigInt(data.amountIn);
    const newReserveOut = reserveOut - amountOut;

    // Update user balances
    const deductSuccess = await adjustBalance(sender, tokenIn_symbol, -toBigInt(data.amountIn));
    if (!deductSuccess) {
        logger.error(`[pool-swap] Failed to deduct ${data.amountIn} ${tokenIn_symbol} from ${sender}.`);
        return false;
    }
    const creditSuccess = await adjustBalance(sender, tokenOut_symbol, amountOut);
    if (!creditSuccess) {
        logger.error(`[pool-swap] Failed to credit ${amountOut} ${tokenOut_symbol} to ${sender}.`);
        return false;
    }

    // Save updated pool state
    const poolUpdateSet: any = {
        lastTradeAt: new Date().toISOString(),
        feeGrowthGlobalA: toDbString(newFeeGrowthGlobalA),
        feeGrowthGlobalB: toDbString(newFeeGrowthGlobalB)
    };
    if (tokenInIsA) {
        poolUpdateSet.tokenA_reserve = toDbString(newReserveIn);
        poolUpdateSet.tokenB_reserve = toDbString(newReserveOut);
    } else {
        poolUpdateSet.tokenB_reserve = toDbString(newReserveIn);
        poolUpdateSet.tokenA_reserve = toDbString(newReserveOut);
    }

    const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
        $set: poolUpdateSet
    });

    if (!updateSuccess) {
        logger.error(`[pool-swap] Failed to update pool ${data.poolId} reserves. Critical: Balances changed but pool reserves not.`);
        return false;
    }

    logger.info(`[pool-swap] Successful single-hop swap by ${sender} in pool ${data.poolId}: ${data.amountIn} ${tokenIn_symbol} -> ${amountOut} ${tokenOut_symbol}`);

    // Log event
    await logEvent('defi', 'swap', sender, {
      poolId: data.poolId,
      tokenIn: tokenIn_symbol,
      tokenOut: tokenOut_symbol,
      amountIn: toDbString(toBigInt(data.amountIn)),
      amountOut: toDbString(amountOut),
      fee: toDbString(feeAmount),
      feeTier: 300, // Fixed 0.3% fee
      tokenA_symbol: poolFromDb.tokenA_symbol,
      tokenB_symbol: poolFromDb.tokenB_symbol
    }, transactionId);

    return true;
}

/**
 * Single-hop swap that returns detailed result including output amount
 * This is a copy of processSingleHopSwap but returns PoolSwapResult instead of boolean
 */
async function processSingleHopSwapWithResult(data: PoolSwapData, sender: string, transactionId: string): Promise<PoolSwapResult> {
    try {
        // Get pool data
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId });
        if (!poolFromDb) {
            return { success: false, amountOut: BigInt(0), error: `Pool ${data.poolId} not found` };
        }

        // Determine token indices
        const tokenInIsA = data.tokenIn_symbol === poolFromDb.tokenA_symbol;
        const tokenIn_symbol = tokenInIsA ? poolFromDb.tokenA_symbol : poolFromDb.tokenB_symbol;
        const tokenOut_symbol = tokenInIsA ? poolFromDb.tokenB_symbol : poolFromDb.tokenA_symbol;
        const reserveIn = tokenInIsA ? toBigInt(poolFromDb.tokenA_reserve) : toBigInt(poolFromDb.tokenB_reserve);
        const reserveOut = tokenInIsA ? toBigInt(poolFromDb.tokenB_reserve) : toBigInt(poolFromDb.tokenA_reserve);

        // Calculate output amount using constant product formula (same as HTTP API)
        const amountOut = getOutputAmountBigInt(toBigInt(data.amountIn), reserveIn, reserveOut);

        // Calculate fee amount and update feeGrowthGlobal
        const feeDivisor = BigInt(10000);
        const feeAmount = (toBigInt(data.amountIn) * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
        const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
        let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
        let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');
        
        if (totalLpTokens > 0n && feeAmount > 0n) {
            const feeGrowthDelta = (feeAmount * BigInt(1e18)) / totalLpTokens;
            if (tokenInIsA) {
                newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
            } else {
                newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
            }
        }

        // Ensure minimum output amount is met
        if (data.minAmountOut && amountOut < toBigInt(data.minAmountOut)) {
            return { success: false, amountOut: BigInt(0), error: `Output amount ${amountOut} is less than minimum required ${data.minAmountOut}` };
        }

        // Update pool reserves
        const newReserveIn = reserveIn + toBigInt(data.amountIn);
        const newReserveOut = reserveOut - amountOut;

        // Update user balances
        const deductSuccess = await adjustBalance(sender, tokenIn_symbol, -toBigInt(data.amountIn));
        if (!deductSuccess) {
            return { success: false, amountOut: BigInt(0), error: `Failed to deduct ${data.amountIn} ${tokenIn_symbol} from ${sender}` };
        }
        const creditSuccess = await adjustBalance(sender, tokenOut_symbol, amountOut);
        if (!creditSuccess) {
            return { success: false, amountOut: BigInt(0), error: `Failed to credit ${amountOut} ${tokenOut_symbol} to ${sender}` };
        }

        // Save updated pool state
        const poolUpdateSet: any = {
            lastTradeAt: new Date().toISOString(),
            feeGrowthGlobalA: toDbString(newFeeGrowthGlobalA),
            feeGrowthGlobalB: toDbString(newFeeGrowthGlobalB)
        };
        if (tokenInIsA) {
            poolUpdateSet.tokenA_reserve = toDbString(newReserveIn);
            poolUpdateSet.tokenB_reserve = toDbString(newReserveOut);
        } else {
            poolUpdateSet.tokenB_reserve = toDbString(newReserveIn);
            poolUpdateSet.tokenA_reserve = toDbString(newReserveOut);
        }

        const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
            $set: poolUpdateSet
        });

        if (!updateSuccess) {
            return { success: false, amountOut: BigInt(0), error: `Failed to update pool ${data.poolId} reserves` };
        }

        logger.info(`[pool-swap] Successful single-hop swap by ${sender} in pool ${data.poolId}: ${data.amountIn} ${tokenIn_symbol} -> ${amountOut} ${tokenOut_symbol}`);

        // Log event
        await logEvent('defi', 'swap', sender, {
            poolId: data.poolId,
            tokenIn: tokenIn_symbol,
            tokenOut: tokenOut_symbol,
            amountIn: toDbString(toBigInt(data.amountIn)),
            amountOut: toDbString(amountOut),
            fee: toDbString(feeAmount),
            feeTier: 300, // Fixed 0.3% fee
            tokenA_symbol: poolFromDb.tokenA_symbol,
            tokenB_symbol: poolFromDb.tokenB_symbol
        }, transactionId);

        return { success: true, amountOut };
    } catch (error) {
        return { success: false, amountOut: BigInt(0), error: `Swap error: ${error}` };
    }
}

async function processRoutedSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    let currentAmountIn = toBigInt(data.amountIn);
    let totalAmountOut = BigInt(0);
    const swapResults: Array<{ poolId: string, tokenIn: string, tokenOut: string, amountIn: string, amountOut: string }> = [];

    // Process each hop in sequence
    for (let i = 0; i < data.hops!.length; i++) {
        const hop = data.hops![i];

        // Get pool data for this hop
        const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: hop.poolId })) as any; // validateTx ensures existence

        // Determine token indices for this hop
        const tokenInIsA = hop.tokenIn_symbol === poolFromDb.tokenA_symbol;
        const tokenIn_symbol = tokenInIsA ? poolFromDb.tokenA_symbol : poolFromDb.tokenB_symbol;
        const tokenOut_symbol = tokenInIsA ? poolFromDb.tokenB_symbol : poolFromDb.tokenA_symbol;
        const reserveIn = tokenInIsA ? toBigInt(poolFromDb.tokenA_reserve) : toBigInt(poolFromDb.tokenB_reserve);
        const reserveOut = tokenInIsA ? toBigInt(poolFromDb.tokenB_reserve) : toBigInt(poolFromDb.tokenA_reserve);

        // Calculate output amount for this hop (same as HTTP API)
        const amountOut = getOutputAmountBigInt(currentAmountIn, reserveIn, reserveOut);

        // Calculate fee amount and update feeGrowthGlobal
        const feeDivisor = BigInt(10000);
        const feeAmount = (currentAmountIn * BigInt(300)) / feeDivisor; // Fixed 0.3% fee
        const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
        let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
        let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');
        
        if (totalLpTokens > 0n && feeAmount > 0n) {
            const feeGrowthDelta = (feeAmount * BigInt(1e18)) / totalLpTokens;
            if (tokenInIsA) {
                newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
            } else {
                newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
            }
        }

        // Check minimum output for this hop
        if (hop.minAmountOut && amountOut < toBigInt(hop.minAmountOut)) {
            logger.warn(`[pool-swap] Output amount ${amountOut} is less than minimum required ${hop.minAmountOut} for hop ${i + 1}.`);
            return false;
        }

        // Update pool reserves for this hop
        const newReserveIn = reserveIn + currentAmountIn;
        const newReserveOut = reserveOut - amountOut;

        // Update user balances for this hop
        const deductSuccess = await adjustBalance(sender, tokenIn_symbol, -currentAmountIn);
        if (!deductSuccess) {
            logger.error(`[pool-swap] Failed to deduct ${currentAmountIn} ${tokenIn_symbol} from ${sender} in hop ${i + 1}.`);
            return false;
        }
        const creditSuccess = await adjustBalance(sender, tokenOut_symbol, amountOut);
        if (!creditSuccess) {
            logger.error(`[pool-swap] Failed to credit ${amountOut} ${tokenOut_symbol} to ${sender} in hop ${i + 1}.`);
            return false;
        }

        // Save updated pool state for this hop
        const poolUpdateSet: any = {
            lastTradeAt: new Date().toISOString(),
            feeGrowthGlobalA: toDbString(newFeeGrowthGlobalA),
            feeGrowthGlobalB: toDbString(newFeeGrowthGlobalB)
        };
        if (tokenInIsA) {
            poolUpdateSet.tokenA_reserve = toDbString(newReserveIn);
            poolUpdateSet.tokenB_reserve = toDbString(newReserveOut);
        } else {
            poolUpdateSet.tokenB_reserve = toDbString(newReserveIn);
            poolUpdateSet.tokenA_reserve = toDbString(newReserveOut);
        }

        const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: hop.poolId }, {
            $set: poolUpdateSet
        });

        if (!updateSuccess) {
            logger.error(`[pool-swap] Failed to update pool ${hop.poolId} reserves in hop ${i + 1}.`);
            return false;
        }

        // Store result for this hop
        swapResults.push({
            poolId: hop.poolId,
            tokenIn: tokenIn_symbol,
            tokenOut: tokenOut_symbol,
            amountIn: currentAmountIn.toString(),
            amountOut: amountOut.toString()
        });

        // Update for next hop
        currentAmountIn = amountOut;
        if (i === data.hops!.length - 1) {
            totalAmountOut = amountOut;
        }
    }

    // Check final minimum output
    if (data.minAmountOut && totalAmountOut < toBigInt(data.minAmountOut)) {
        logger.warn(`[pool-swap] Final output amount ${totalAmountOut} is less than minimum required ${data.minAmountOut}.`);
        return false;
    }

    logger.info(`[pool-swap] Successful multi-hop swap by ${sender}: ${data.amountIn} ${data.hops![0].tokenIn_symbol} -> ${totalAmountOut} ${data.hops![data.hops!.length - 1].tokenOut_symbol} through ${data.hops!.length} hops`);

    // Log event - get pool data for the first hop to access feeTier and token symbols
    const firstPoolData = await cache.findOnePromise('liquidityPools', { _id: data.hops![0].poolId });
    await logEvent('defi', 'swap', sender, {
        poolId: data.hops![0].poolId, // Use the first hop's poolId instead of data.poolId
        tokenIn: data.hops![0].tokenIn_symbol,
        tokenOut: data.hops![data.hops!.length - 1].tokenOut_symbol,
        amountIn: toDbString(toBigInt(data.amountIn)),
        amountOut: toDbString(totalAmountOut),
        fee: toDbString(totalAmountOut * BigInt(10000) / toBigInt(data.amountIn)),
        feeTier: 300, // Fixed 0.3% fee
        tokenA_symbol: firstPoolData?.tokenA_symbol || data.hops![0].tokenIn_symbol,
        tokenB_symbol: firstPoolData?.tokenB_symbol || data.hops![0].tokenOut_symbol
    }, transactionId);

    return true;
}

async function processAutoRouteSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Find the best route
    const bestRoute = await findBestTradeRoute(data.fromTokenSymbol!, data.toTokenSymbol!, toBigInt(data.amountIn));
    if (!bestRoute) {
        logger.warn(`[pool-swap] No route found from ${data.fromTokenSymbol} to ${data.toTokenSymbol}.`);
        return false;
    }

    // Apply slippage tolerance (default 1% if not specified)
    const slippagePercent = data.slippagePercent || 1.0; // Default 1% slippage
    const expectedFinalOutput = toBigInt(bestRoute.finalAmountOut);

    // If user provided minAmountOut, use it; otherwise apply slippage
    const finalMinAmountOut = data.minAmountOut ?
        toBigInt(data.minAmountOut) :
        (expectedFinalOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

    // Convert the route to hops format with slippage-adjusted minimums
    const hops = bestRoute.hops.map((hop, index) => {
        const expectedOutput = toBigInt(hop.amountOut);
        let minAmountOut: bigint;

        if (index === bestRoute.hops.length - 1) {
            // For the final hop, use the final minimum amount
            minAmountOut = finalMinAmountOut;
        } else {
            // For intermediate hops, apply slippage
            minAmountOut = (expectedOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);
        }

        return {
            poolId: hop.poolId,
            tokenIn_symbol: hop.tokenIn,
            tokenOut_symbol: hop.tokenOut,
            amountIn: toBigInt(hop.amountIn),
            minAmountOut: minAmountOut
        };
    });

    const routedData: PoolSwapData = {
        ...data,
        hops: hops,
        minAmountOut: finalMinAmountOut
    };

    logger.info(`[pool-swap] Auto-route swap: ${data.amountIn} ${data.fromTokenSymbol} -> ${expectedFinalOutput} ${data.toTokenSymbol} (min: ${finalMinAmountOut})`);

    return await processRoutedSwap(routedData, sender, transactionId);
}