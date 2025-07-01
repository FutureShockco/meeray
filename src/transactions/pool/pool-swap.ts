import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, LiquidityPool, PoolSwapDataDB, LiquidityPoolDB } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';
import { BigIntMath, convertToBigInt, toString as bigintToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import mongo from '../../mongo.js';

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
    feeTier: number;
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
    outputReserve: bigint,
    feeTier: number
): bigint {
    if (inputAmount <= 0n || inputReserve <= 0n || outputReserve <= 0n) {
        return 0n;
    }

    // Use the same calculation method as the HTTP API
    // Fee tiers are in basis points: 10 = 0.01%, 50 = 0.05%, 300 = 0.3%, 1000 = 1%
    const feeMultiplier = BigInt(10000) - BigInt(feeTier); // e.g., 10000 - 300 = 9700 for 0.3% fee
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
        feeTier: p.feeTier || 300
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

            const tokenInReserve = BigIntMath.toBigInt(tokenInReserveStr);
            const tokenOutReserve = BigIntMath.toBigInt(tokenOutReserveStr);
            if (tokenInReserve <= 0n || tokenOutReserve <= 0n) continue;
            if (currentPath.length > 0 && currentPath[currentPath.length - 1].tokenIn === nextTokenSymbol) continue;

            const amountOutFromHop = getOutputAmountBigInt(currentAmountIn, tokenInReserve, tokenOutReserve, pool.feeTier);
            if (amountOutFromHop <= 0n) continue;

            const priceImpact = calculatePriceImpact(currentAmountIn, tokenInReserve);

            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentTokenSymbol,
                tokenOut: nextTokenSymbol,
                amountIn: bigintToString(currentAmountIn),
                amountOut: bigintToString(amountOutFromHop),
                priceImpact: priceImpact
            };
            const newPath = [...currentPath, newHop];

            if (nextTokenSymbol === endTokenSymbol) {
                routes.push({
                    hops: newPath,
                    finalAmountIn: bigintToString(initialAmountIn),
                    finalAmountOut: bigintToString(amountOutFromHop)
                });
            } else {
                queue.push([nextTokenSymbol, newPath, amountOutFromHop]);
            }
        }
    }

    // Return the best route (highest output amount)
    return routes.sort((a, b) => BigIntMath.toBigInt(b.finalAmountOut) - BigIntMath.toBigInt(a.finalAmountOut) > 0n ? 1 : -1)[0] || null;
}

export async function validateTx(dataDb: PoolSwapDataDB, sender: string): Promise<boolean> {
    try {
        const data = convertToBigInt<PoolSwapData>(dataDb, NUMERIC_FIELDS_SWAP);

        if (!BigIntMath.isPositive(data.amountIn)) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return false;
        }

        if (data.minAmountOut !== undefined && !BigIntMath.isPositive(data.minAmountOut)) {
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
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found.`);
        return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

    // Verify token symbols match
    if (!((pool.tokenA_symbol === data.tokenIn_symbol && pool.tokenB_symbol === data.tokenOut_symbol) ||
        (pool.tokenB_symbol === data.tokenIn_symbol && pool.tokenA_symbol === data.tokenOut_symbol))) {
        logger.warn('[pool-swap] Token symbols do not match pool configuration.');
        return false;
    }

    // Check pool liquidity
    if (BigIntMath.isZero(pool.tokenA_reserve) || BigIntMath.isZero(pool.tokenB_reserve)) {
        logger.warn(`[pool-swap] Pool ${data.poolId} has insufficient liquidity.`);
        return false;
    }

    // Check trader balance
    const tokenInIdentifier = data.tokenIn_symbol;
    const traderBalance = BigIntMath.toBigInt(traderAccount.balances?.[tokenInIdentifier] || '0');
    if (traderBalance < data.amountIn) {
        logger.warn(`[pool-swap] Insufficient balance for ${tokenInIdentifier}. Has ${bigintToString(traderBalance)}, needs ${bigintToString(data.amountIn)}`);
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
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: hop.poolId }) as LiquidityPoolDB | null;
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} not found for hop ${i + 1}.`);
            return false;
        }
        const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

        // Verify token symbols match for this hop
        if (!((pool.tokenA_symbol === hop.tokenIn_symbol && pool.tokenB_symbol === hop.tokenOut_symbol) ||
              (pool.tokenB_symbol === hop.tokenIn_symbol && pool.tokenA_symbol === hop.tokenOut_symbol))) {
            logger.warn(`[pool-swap] Token symbols do not match pool configuration for hop ${i + 1}.`);
            return false;
        }

        // Check pool liquidity
        if (BigIntMath.isZero(pool.tokenA_reserve) || BigIntMath.isZero(pool.tokenB_reserve)) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} has insufficient liquidity for hop ${i + 1}.`);
            return false;
        }

        // Calculate actual output for this hop (same as HTTP API)
        const tokenInIsA = hop.tokenIn_symbol === pool.tokenA_symbol;
        const reserveIn = tokenInIsA ? pool.tokenA_reserve : pool.tokenB_reserve;
        const reserveOut = tokenInIsA ? pool.tokenB_reserve : pool.tokenA_reserve;

        const amountOut = getOutputAmountBigInt(currentAmountIn, reserveIn, reserveOut, pool.feeTier);

        // Check if actual calculation meets minimum (same as execution)
        if (hop.minAmountOut && amountOut < hop.minAmountOut) {
            logger.warn(`[pool-swap] Validation: Output amount ${bigintToString(amountOut)} is less than minimum required ${bigintToString(hop.minAmountOut)} for hop ${i + 1}.`);
            return false;
        }

        // Update for next hop
        currentAmountIn = amountOut;
    }

    // Check final minimum output
    if (data.minAmountOut && currentAmountIn < data.minAmountOut) {
        logger.warn(`[pool-swap] Validation: Final output amount ${bigintToString(currentAmountIn)} is less than minimum required ${bigintToString(data.minAmountOut)}.`);
        return false;
    }

    // Check initial balance (only need to check the first token)
    const initialTokenSymbol = data.hops![0].tokenIn_symbol;
    const traderBalance = BigIntMath.toBigInt(traderAccount.balances?.[initialTokenSymbol] || '0');
    if (traderBalance < data.amountIn) {
        logger.warn(`[pool-swap] Insufficient balance for ${initialTokenSymbol}. Has ${bigintToString(traderBalance)}, needs ${bigintToString(data.amountIn)}`);
        return false;
    }

    return true;
}

async function validateAutoRouteSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
    // Find the best route
    const bestRoute = await findBestTradeRoute(data.fromTokenSymbol!, data.toTokenSymbol!, data.amountIn);
    if (!bestRoute) {
        logger.warn(`[pool-swap] No route found from ${data.fromTokenSymbol} to ${data.toTokenSymbol}.`);
        return false;
    }

    // Apply slippage tolerance (same logic as execution)
    const slippagePercent = data.slippagePercent || 1.0;
    const expectedFinalOutput = BigIntMath.toBigInt(bestRoute.finalAmountOut);
    
    // Calculate minimum output (same logic as execution)
    const finalMinAmountOut = data.minAmountOut || 
        (expectedFinalOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

    // Validate each hop using the same calculation logic as execution
    let currentAmountIn = data.amountIn;
    for (let i = 0; i < bestRoute.hops.length; i++) {
        const hop = bestRoute.hops[i];
        
        // Get current pool data (same as execution)
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: hop.poolId }) as LiquidityPoolDB | null;
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} not found during validation for hop ${i + 1}.`);
            return false;
        }
        const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

        // Determine token indices (same as execution)
        const tokenInIsA = hop.tokenIn === pool.tokenA_symbol;
        const reserveIn = tokenInIsA ? pool.tokenA_reserve : pool.tokenB_reserve;
        const reserveOut = tokenInIsA ? pool.tokenB_reserve : pool.tokenA_reserve;

        // Calculate output amount using the same formula as HTTP API
        const amountOut = getOutputAmountBigInt(currentAmountIn, reserveIn, reserveOut, pool.feeTier);

        // Calculate minimum for this hop (same as execution)
        const expectedOutput = BigIntMath.toBigInt(hop.amountOut);
        const hopMinAmountOut = (expectedOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

        // Check if actual calculation meets minimum (same as execution)
        if (amountOut < hopMinAmountOut) {
            logger.warn(`[pool-swap] Validation: Output amount ${bigintToString(amountOut)} is less than minimum required ${bigintToString(hopMinAmountOut)} for hop ${i + 1}.`);
            return false;
        }

        // Update for next hop
        currentAmountIn = amountOut;
    }

    // Check final minimum output
    if (data.minAmountOut && currentAmountIn < data.minAmountOut) {
        logger.warn(`[pool-swap] Validation: Final output amount ${bigintToString(currentAmountIn)} is less than minimum required ${bigintToString(data.minAmountOut)}.`);
        return false;
    }

    // Check initial balance
    const traderBalance = BigIntMath.toBigInt(traderAccount.balances?.[data.fromTokenSymbol!] || '0');
    if (traderBalance < data.amountIn) {
        logger.warn(`[pool-swap] Insufficient balance for ${data.fromTokenSymbol}. Has ${bigintToString(traderBalance)}, needs ${bigintToString(data.amountIn)}`);
        return false;
    }

    return true;
}

export async function process(dataDb: PoolSwapDataDB, sender: string, transactionId: string): Promise<boolean> {
    const data = convertToBigInt<PoolSwapData>(dataDb, NUMERIC_FIELDS_SWAP);

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

async function processSingleHopSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Get pool data
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found during processing.`);
        return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

    // Determine token indices
    const tokenInIsA = data.tokenIn_symbol === pool.tokenA_symbol;
    const tokenIn_symbol = tokenInIsA ? pool.tokenA_symbol : pool.tokenB_symbol;
    const tokenOut_symbol = tokenInIsA ? pool.tokenB_symbol : pool.tokenA_symbol;
    const reserveIn = tokenInIsA ? pool.tokenA_reserve : pool.tokenB_reserve;
    const reserveOut = tokenInIsA ? pool.tokenB_reserve : pool.tokenA_reserve;

        // Calculate output amount using constant product formula (same as HTTP API)
    const amountOut = getOutputAmountBigInt(data.amountIn, reserveIn, reserveOut, pool.feeTier);

    if (BigIntMath.isZero(amountOut)) {
        logger.warn(`[pool-swap] Calculated swap amountOut is zero for pool ${data.poolId}. amountIn: ${bigintToString(data.amountIn)}, reserveIn: ${bigintToString(reserveIn)}, reserveOut: ${bigintToString(reserveOut)}`);
        if (data.minAmountOut && data.minAmountOut > BigInt(0)) {
            logger.warn(`[pool-swap] Output amount is zero and minAmountOut is ${bigintToString(data.minAmountOut)}. Swap failed.`);
            return false;
        }
    }

    // Ensure minimum output amount is met
    if (data.minAmountOut && amountOut < data.minAmountOut) {
        logger.warn(`[pool-swap] Output amount ${bigintToString(amountOut)} is less than minimum required ${bigintToString(data.minAmountOut)}.`);
        return false;
    }

    // Update pool reserves
    const newReserveIn = BigIntMath.add(reserveIn, data.amountIn);
    const newReserveOut = BigIntMath.sub(reserveOut, amountOut);

    // Update user balances
    const deductSuccess = await adjustBalance(sender, tokenIn_symbol, -data.amountIn);
    if (!deductSuccess) {
        logger.error(`[pool-swap] Failed to deduct ${bigintToString(data.amountIn)} ${tokenIn_symbol} from ${sender}.`);
        return false;
    }
    const creditSuccess = await adjustBalance(sender, tokenOut_symbol, amountOut);
    if (!creditSuccess) {
        logger.error(`[pool-swap] Failed to credit ${bigintToString(amountOut)} ${tokenOut_symbol} to ${sender}. Rolling back deduction.`);
        await adjustBalance(sender, tokenIn_symbol, data.amountIn); // Credit back
        return false;
    }

    // Save updated pool state
    const poolUpdateSet: any = {
        lastTradeAt: new Date().toISOString()
    };
    if (tokenInIsA) {
        poolUpdateSet.tokenA_reserve = bigintToString(newReserveIn);
        poolUpdateSet.tokenB_reserve = bigintToString(newReserveOut);
    } else {
        poolUpdateSet.tokenB_reserve = bigintToString(newReserveIn);
        poolUpdateSet.tokenA_reserve = bigintToString(newReserveOut);
    }

    const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
        $set: poolUpdateSet
    });

    if (!updateSuccess) {
        logger.error(`[pool-swap] Failed to update pool ${data.poolId} reserves. Critical: Balances changed but pool reserves not. Rolling back balance changes.`);
        // Attempt to rollback balance changes
        await adjustBalance(sender, tokenOut_symbol, -amountOut); // Deduct credited amountOut
        await adjustBalance(sender, tokenIn_symbol, data.amountIn); // Credit back original amountIn
        return false;
    }

    logger.info(`[pool-swap] Successful single-hop swap by ${sender} in pool ${data.poolId}: ${bigintToString(data.amountIn)} ${tokenIn_symbol} -> ${bigintToString(amountOut)} ${tokenOut_symbol}`);

    // Log event
    const eventData = {
        poolId: data.poolId,
        sender: sender,
        tokenIn_symbol: tokenIn_symbol,
        amountIn: bigintToString(data.amountIn),
        tokenOut_symbol: tokenOut_symbol,
        amountOut: bigintToString(amountOut),
        feeTier: pool.feeTier,
        swapType: 'single-hop'
    };
    await logTransactionEvent('poolSwap', sender, eventData, transactionId);

    return true;
}

async function processRoutedSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    let currentAmountIn = data.amountIn;
    let totalAmountOut = BigInt(0);
    const swapResults: Array<{ poolId: string, tokenIn: string, tokenOut: string, amountIn: string, amountOut: string }> = [];

    // Process each hop in sequence
    for (let i = 0; i < data.hops!.length; i++) {
        const hop = data.hops![i];

        // Get pool data for this hop
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: hop.poolId }) as LiquidityPoolDB | null;
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${hop.poolId} not found during processing for hop ${i + 1}.`);
            return false;
        }
        const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

        // Determine token indices for this hop
        const tokenInIsA = hop.tokenIn_symbol === pool.tokenA_symbol;
        const tokenIn_symbol = tokenInIsA ? pool.tokenA_symbol : pool.tokenB_symbol;
        const tokenOut_symbol = tokenInIsA ? pool.tokenB_symbol : pool.tokenA_symbol;
        const reserveIn = tokenInIsA ? pool.tokenA_reserve : pool.tokenB_reserve;
        const reserveOut = tokenInIsA ? pool.tokenB_reserve : pool.tokenA_reserve;

                // Calculate output amount for this hop (same as HTTP API)
        const amountOut = getOutputAmountBigInt(currentAmountIn, reserveIn, reserveOut, pool.feeTier);

        // Check minimum output for this hop
        if (hop.minAmountOut && amountOut < hop.minAmountOut) {
            logger.warn(`[pool-swap] Output amount ${bigintToString(amountOut)} is less than minimum required ${bigintToString(hop.minAmountOut)} for hop ${i + 1}.`);
            return false;
        }

        // Update pool reserves for this hop
        const newReserveIn = BigIntMath.add(reserveIn, currentAmountIn);
        const newReserveOut = BigIntMath.sub(reserveOut, amountOut);

        // Update user balances for this hop
        const deductSuccess = await adjustBalance(sender, tokenIn_symbol, -currentAmountIn);
        if (!deductSuccess) {
            logger.error(`[pool-swap] Failed to deduct ${bigintToString(currentAmountIn)} ${tokenIn_symbol} from ${sender} in hop ${i + 1}.`);
            return false;
        }
        const creditSuccess = await adjustBalance(sender, tokenOut_symbol, amountOut);
        if (!creditSuccess) {
            logger.error(`[pool-swap] Failed to credit ${bigintToString(amountOut)} ${tokenOut_symbol} to ${sender} in hop ${i + 1}. Rolling back deduction.`);
            await adjustBalance(sender, tokenIn_symbol, currentAmountIn); // Credit back
            return false;
        }

        // Save updated pool state for this hop
        const poolUpdateSet: any = {
            lastTradeAt: new Date().toISOString()
        };
        if (tokenInIsA) {
            poolUpdateSet.tokenA_reserve = bigintToString(newReserveIn);
            poolUpdateSet.tokenB_reserve = bigintToString(newReserveOut);
        } else {
            poolUpdateSet.tokenB_reserve = bigintToString(newReserveIn);
            poolUpdateSet.tokenA_reserve = bigintToString(newReserveOut);
        }

        const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: hop.poolId }, {
            $set: poolUpdateSet
        });

        if (!updateSuccess) {
            logger.error(`[pool-swap] Failed to update pool ${hop.poolId} reserves in hop ${i + 1}. Rolling back balance changes.`);
            await adjustBalance(sender, tokenOut_symbol, -amountOut);
            await adjustBalance(sender, tokenIn_symbol, currentAmountIn);
            return false;
        }

        // Store result for this hop
        swapResults.push({
            poolId: hop.poolId,
            tokenIn: tokenIn_symbol,
            tokenOut: tokenOut_symbol,
            amountIn: bigintToString(currentAmountIn),
            amountOut: bigintToString(amountOut)
        });

        // Update for next hop
        currentAmountIn = amountOut;
        if (i === data.hops!.length - 1) {
            totalAmountOut = amountOut;
        }
    }

    // Check final minimum output
    if (data.minAmountOut && totalAmountOut < data.minAmountOut) {
        logger.warn(`[pool-swap] Final output amount ${bigintToString(totalAmountOut)} is less than minimum required ${bigintToString(data.minAmountOut)}.`);
        return false;
    }

    logger.info(`[pool-swap] Successful multi-hop swap by ${sender}: ${bigintToString(data.amountIn)} ${data.hops![0].tokenIn_symbol} -> ${bigintToString(totalAmountOut)} ${data.hops![data.hops!.length - 1].tokenOut_symbol} through ${data.hops!.length} hops`);

    // Log event
    const eventData = {
        sender: sender,
        tokenIn_symbol: data.hops![0].tokenIn_symbol,
        amountIn: bigintToString(data.amountIn),
        tokenOut_symbol: data.hops![data.hops!.length - 1].tokenOut_symbol,
        amountOut: bigintToString(totalAmountOut),
        hops: swapResults,
        swapType: 'multi-hop'
    };
    await logTransactionEvent('poolSwap', sender, eventData, transactionId);

    return true;
}

async function processAutoRouteSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Find the best route
    const bestRoute = await findBestTradeRoute(data.fromTokenSymbol!, data.toTokenSymbol!, data.amountIn);
    if (!bestRoute) {
        logger.warn(`[pool-swap] No route found from ${data.fromTokenSymbol} to ${data.toTokenSymbol}.`);
        return false;
    }

    // Apply slippage tolerance (default 1% if not specified)
    const slippagePercent = data.slippagePercent || 1.0; // Default 1% slippage
    const expectedFinalOutput = BigIntMath.toBigInt(bestRoute.finalAmountOut);

    // If user provided minAmountOut, use it; otherwise apply slippage
    const finalMinAmountOut = data.minAmountOut ||
        (expectedFinalOutput * BigInt(10000 - Math.floor(slippagePercent * 100))) / BigInt(10000);

    // Convert the route to hops format with slippage-adjusted minimums
    const hops = bestRoute.hops.map((hop, index) => {
        const expectedOutput = BigIntMath.toBigInt(hop.amountOut);
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
            amountIn: BigIntMath.toBigInt(hop.amountIn),
            minAmountOut: minAmountOut
        };
    });

    const routedData: PoolSwapData = {
        ...data,
        hops: hops,
        minAmountOut: finalMinAmountOut
    };

    logger.info(`[pool-swap] Auto-route swap: ${bigintToString(data.amountIn)} ${data.fromTokenSymbol} -> ${bigintToString(expectedFinalOutput)} ${data.toTokenSymbol} (min: ${bigintToString(finalMinAmountOut)})`);

    return await processRoutedSwap(routedData, sender, transactionId);
} 