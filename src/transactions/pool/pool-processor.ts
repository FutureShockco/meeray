import logger from '../../logger.js';
import cache from '../../cache.js';
import { LiquidityPoolData, PoolSwapData, PoolSwapResult, UserLiquidityPositionData } from './pool-interfaces.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { calculateDecimalAwarePrice, toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import crypto from 'crypto';
import { findBestTradeRoute, getOutputAmountBigInt } from '../../utils/pool.js';
import { Account } from '../../mongo.js';
import { recordPoolSwapTrade } from './pool-helpers.js';

export async function validateSingleHopSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
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

export async function validateRoutedSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
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

export async function validateAutoRouteSwap(data: PoolSwapData, sender: string, traderAccount: Account): Promise<boolean> {
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
        (expectedFinalOutput * toBigInt(10000 - Math.floor(slippagePercent * 100))) / toBigInt(10000);

    // Validate each hop using the same calculation logic as execution
    let currentAmountIn = toBigInt(data.amountIn);
    for (let i = 0; i < bestRoute.hops.length; i++) {
        const hop = bestRoute.hops[i];

        // Get current pool data (same as execution)
        const poolFromDb = (await cache.findOnePromise('liquidityPools', { _id: hop.poolId })) as { tokenA_symbol: string; tokenA_reserve: string; tokenB_symbol: string; tokenB_reserve: string };
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
        const hopMinAmountOut = (expectedOutput * toBigInt(10000 - Math.floor(slippagePercent * 100))) / toBigInt(10000);

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
            return { success: false, amountOut: toBigInt(0), error: 'Only single-hop swaps supported in hybrid trading' };
        }
    } catch (error) {
        return { success: false, amountOut: toBigInt(0), error: `Swap error: ${error}` };
    }
}

export async function processSingleHopSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
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
    const feeDivisor = toBigInt(10000);
    const feeAmount = (toBigInt(data.amountIn) * toBigInt(300)) / feeDivisor; // Fixed 0.3% fee
    const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
    let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
    let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');

    if (totalLpTokens > 0n && feeAmount > 0n) {
        const feeGrowthDelta = (feeAmount * toBigInt(1e18)) / totalLpTokens;
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
    const deductSuccess = await adjustUserBalance(sender, tokenIn_symbol, -toBigInt(data.amountIn));
    if (!deductSuccess) {
        logger.error(`[pool-swap] Failed to deduct ${data.amountIn} ${tokenIn_symbol} from ${sender}.`);
        return false;
    }
    const creditSuccess = await adjustUserBalance(sender, tokenOut_symbol, amountOut);
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

    // Record the swap as a market trade
    await recordPoolSwapTrade({
        poolId: data.poolId!,
        tokenIn: tokenIn_symbol,
        tokenOut: tokenOut_symbol,
        amountIn: toBigInt(data.amountIn),
        amountOut: amountOut,
        sender: sender,
        transactionId: transactionId
    });

    // Log event
    await logEvent('defi', 'swap', sender, {
        poolId: data.poolId,
        tokenIn: tokenIn_symbol,
        tokenOut: tokenOut_symbol,
        amountIn: toDbString(data.amountIn),
        amountOut: toDbString(amountOut),
        fee: toDbString(feeAmount),
        tokenA_symbol: poolFromDb.tokenA_symbol,
        tokenB_symbol: poolFromDb.tokenB_symbol
    }, transactionId);

    return true;
}

/**
 * Single-hop swap that returns detailed result including output amount
 * This is a copy of processSingleHopSwap but returns PoolSwapResult instead of boolean
 */
export async function processSingleHopSwapWithResult(data: PoolSwapData, sender: string, transactionId: string): Promise<PoolSwapResult> {
    try {
        // Get pool data
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId });
        if (!poolFromDb) {
            return { success: false, amountOut: toBigInt(0), error: `Pool ${data.poolId} not found` };
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
        const feeDivisor = toBigInt(10000);
        const feeAmount = (toBigInt(data.amountIn) * toBigInt(300)) / feeDivisor; // Fixed 0.3% fee
        const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
        let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
        let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');

        if (totalLpTokens > 0n && feeAmount > 0n) {
            const feeGrowthDelta = (feeAmount * toBigInt(1e18)) / totalLpTokens;
            if (tokenInIsA) {
                newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
            } else {
                newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
            }
        }

        // Ensure minimum output amount is met
        if (data.minAmountOut && amountOut < toBigInt(data.minAmountOut)) {
            return { success: false, amountOut: toBigInt(0), error: `Output amount ${amountOut} is less than minimum required ${data.minAmountOut}` };
        }

        // Update pool reserves
        const newReserveIn = reserveIn + toBigInt(data.amountIn);
        const newReserveOut = reserveOut - amountOut;

        // Update user balances
        const deductSuccess = await adjustUserBalance(sender, tokenIn_symbol, -toBigInt(data.amountIn));
        if (!deductSuccess) {
            return { success: false, amountOut: toBigInt(0), error: `Failed to deduct ${data.amountIn} ${tokenIn_symbol} from ${sender}` };
        }
        const creditSuccess = await adjustUserBalance(sender, tokenOut_symbol, amountOut);
        if (!creditSuccess) {
            return { success: false, amountOut: toBigInt(0), error: `Failed to credit ${amountOut} ${tokenOut_symbol} to ${sender}` };
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
            return { success: false, amountOut: toBigInt(0), error: `Failed to update pool ${data.poolId} reserves` };
        }

        logger.info(`[pool-swap] Successful single-hop swap by ${sender} in pool ${data.poolId}: ${data.amountIn} ${tokenIn_symbol} -> ${amountOut} ${tokenOut_symbol}`);

        // Record the swap as a market trade
        await recordPoolSwapTrade({
            poolId: data.poolId!,
            tokenIn: tokenIn_symbol,
            tokenOut: tokenOut_symbol,
            amountIn: toBigInt(data.amountIn),
            amountOut: amountOut,
            sender: sender,
            transactionId: transactionId
        });

        // Log event
        await logEvent('defi', 'swap', sender, {
            poolId: data.poolId,
            tokenIn: tokenIn_symbol,
            tokenOut: tokenOut_symbol,
            amountIn: toDbString(data.amountIn),
            amountOut: toDbString(amountOut),
            fee: toDbString(feeAmount),
            tokenA_symbol: poolFromDb.tokenA_symbol,
            tokenB_symbol: poolFromDb.tokenB_symbol
        }, transactionId);

        return { success: true, amountOut };
    } catch (error) {
        return { success: false, amountOut: toBigInt(0), error: `Swap error: ${error}` };
    }
}

export async function processRoutedSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    let currentAmountIn = toBigInt(data.amountIn);
    let totalAmountOut = toBigInt(0);
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
        const feeDivisor = toBigInt(10000);
        const feeAmount = (currentAmountIn * toBigInt(300)) / feeDivisor; // Fixed 0.3% fee
        const totalLpTokens = toBigInt(poolFromDb.totalLpTokens);
        let newFeeGrowthGlobalA = toBigInt(poolFromDb.feeGrowthGlobalA || '0');
        let newFeeGrowthGlobalB = toBigInt(poolFromDb.feeGrowthGlobalB || '0');

        if (totalLpTokens > 0n && feeAmount > 0n) {
            const feeGrowthDelta = (feeAmount * toBigInt(1e18)) / totalLpTokens;
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
        const deductSuccess = await adjustUserBalance(sender, tokenIn_symbol, -currentAmountIn);
        if (!deductSuccess) {
            logger.error(`[pool-swap] Failed to deduct ${currentAmountIn} ${tokenIn_symbol} from ${sender} in hop ${i + 1}.`);
            return false;
        }
        const creditSuccess = await adjustUserBalance(sender, tokenOut_symbol, amountOut);
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

    // Record the multi-hop swap as a market trade (overall trade from first token to last token)
    await recordPoolSwapTrade({
        poolId: data.hops![0].poolId, // Use first hop's pool ID
        tokenIn: data.hops![0].tokenIn_symbol,
        tokenOut: data.hops![data.hops!.length - 1].tokenOut_symbol,
        amountIn: toBigInt(data.amountIn),
        amountOut: totalAmountOut,
        sender: sender,
        transactionId: transactionId
    });

    // Log event - get pool data for the first hop to access token symbols
    const firstPoolData = await cache.findOnePromise('liquidityPools', { _id: data.hops![0].poolId });
    await logEvent('defi', 'swap', sender, {
        poolId: data.hops![0].poolId, // Use the first hop's poolId instead of data.poolId
        tokenIn: data.hops![0].tokenIn_symbol,
        tokenOut: data.hops![data.hops!.length - 1].tokenOut_symbol,
        amountIn: toDbString(data.amountIn),
        amountOut: toDbString(totalAmountOut),
        fee: toDbString(totalAmountOut * toBigInt(10000) / toBigInt(data.amountIn)),
        tokenA_symbol: firstPoolData?.tokenA_symbol || data.hops![0].tokenIn_symbol,
        tokenB_symbol: firstPoolData?.tokenB_symbol || data.hops![0].tokenOut_symbol
    }, transactionId);

    return true;
}

export async function processAutoRouteSwap(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
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
        (expectedFinalOutput * toBigInt(10000 - Math.floor(slippagePercent * 100))) / toBigInt(10000);

    // Convert the route to hops format with slippage-adjusted minimums
    const hops = bestRoute.hops.map((hop, index) => {
        const expectedOutput = toBigInt(hop.amountOut);
        let minAmountOut: bigint;

        if (index === bestRoute.hops.length - 1) {
            // For the final hop, use the final minimum amount
            minAmountOut = finalMinAmountOut;
        } else {
            // For intermediate hops, apply slippage
            minAmountOut = (expectedOutput * toBigInt(10000 - Math.floor(slippagePercent * 100))) / toBigInt(10000);
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
