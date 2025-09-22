import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, PoolSwapResult } from './pool-interfaces.js';
import { adjustBalance, getAccount } from '../../utils/account.js';
import { Account } from '../../mongo.js';
import { toBigInt, toDbString, calculateDecimalAwarePrice } from '../../utils/bigint.js';
import { getOutputAmountBigInt } from '../../utils/pool.js';
import { findBestTradeRoute } from '../../utils/pool.js';
import { logEvent } from '../../utils/event-logger.js';
import crypto from 'crypto';

export async function validateTx(data: PoolSwapData, sender: string): Promise<boolean> {
    try {
        if (toBigInt(data.amountIn) <= 0n) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return false;
        }
        if (data.minAmountOut !== undefined && !validate.bigint(data.minAmountOut, false, false)) {
            logger.warn('[pool-swap] minAmountOut, if provided, must be a positive BigInt.');
            return false;
        }
        if (data.slippagePercent !== undefined && !validate.integer(data.slippagePercent, true, false, 100, 0)) {
            logger.warn('[pool-swap] slippagePercent must be between 0 and 100 percent.');
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

// Helper function to find trading pair ID regardless of token order
async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
    // Try both orders: tokenA-tokenB and tokenB-tokenA
    let pairId = `${tokenA}-${tokenB}`;
    let tradingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });

    if (!tradingPair) {
        pairId = `${tokenB}-${tokenA}`;
        tradingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    }

    return tradingPair ? pairId : null;
}

// Helper function to record pool swaps as market trades
async function recordPoolSwapTrade(params: {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
    sender: string;
    transactionId: string;
}): Promise<void> {
    try {
        // Find the correct trading pair ID regardless of token order
        const pairId = await findTradingPairId(params.tokenIn, params.tokenOut);
        if (!pairId) {
            logger.debug(`[pool-swap] No trading pair found for ${params.tokenIn}-${params.tokenOut}, skipping trade record`);
            return;
        }

        // Get the trading pair to determine correct base/quote assignment
        const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (!pair) {
            logger.warn(`[pool-swap] Trading pair ${pairId} not found, using token symbols as-is`);
        }

        // Determine correct base/quote mapping and trade side
        let baseSymbol, quoteSymbol, tradeSide: 'buy' | 'sell';
        let buyerUserId: string;
        let sellerUserId: string;
        let quantity: bigint;
        let volume: bigint;
        let price: bigint;

        if (pair) {
            baseSymbol = pair.baseAssetSymbol;
            quoteSymbol = pair.quoteAssetSymbol;

            // Determine trade side based on token direction
            if (params.tokenOut === baseSymbol) {
                // User is buying the base asset (tokenOut = base), it's a BUY
                tradeSide = 'buy';
                buyerUserId = params.sender;
                sellerUserId = 'POOL';
                quantity = params.amountOut; // Amount of base received
                volume = params.amountIn;    // Amount of quote spent
                // Price = quote spent / base received = amountIn / amountOut
                price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            } else if (params.tokenIn === baseSymbol) {
                // User is selling the base asset (tokenIn = base), it's a SELL
                tradeSide = 'sell';
                buyerUserId = 'POOL';
                sellerUserId = params.sender;
                quantity = params.amountIn;  // Amount of base sold
                volume = params.amountOut;   // Amount of quote received
                // Price = quote received / base sold = amountOut / amountIn
                price = calculateDecimalAwarePrice(params.amountOut, params.amountIn, quoteSymbol, baseSymbol);
            } else {
                // Fallback to buy if we can't determine the direction
                logger.warn(`[pool-swap] Could not determine trade side for ${params.tokenIn} -> ${params.tokenOut}, defaulting to buy`);
                tradeSide = 'buy';
                buyerUserId = params.sender;
                sellerUserId = 'POOL';
                quantity = params.amountOut;
                volume = params.amountIn;
                price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
            }
        } else {
            // Fallback when pair info is not available
            baseSymbol = params.tokenOut;
            quoteSymbol = params.tokenIn;
            tradeSide = 'buy';
            buyerUserId = params.sender;
            sellerUserId = 'POOL';
            quantity = params.amountOut;
            volume = params.amountIn;
            price = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
        }

        // Create trade record matching the orderbook trade format with deterministic ID
        const tradeId = crypto.createHash('sha256')
            .update(`${pairId}-${params.tokenIn}-${params.tokenOut}-${params.sender}-${params.transactionId}-${params.amountOut}`)
            .digest('hex')
            .substring(0, 16);
        const tradeRecord = {
            _id: tradeId,
            pairId: pairId,
            baseAssetSymbol: baseSymbol,
            quoteAssetSymbol: quoteSymbol,
            makerOrderId: null, // Pool swaps don't have maker orders
            takerOrderId: null, // Pool swaps don't have taker orders
            buyerUserId: buyerUserId,
            sellerUserId: sellerUserId,
            price: price.toString(),
            quantity: quantity.toString(),
            volume: volume.toString(),
            timestamp: Date.now(),
            side: tradeSide,
            type: 'market', // Pool swaps are market orders
            source: 'pool', // Mark as pool source
            isMakerBuyer: false,
            feeAmount: '0', // Fees are handled in the pool swap
            feeCurrency: quoteSymbol,
            makerFee: '0',
            takerFee: '0',
            total: volume.toString()
        };

        // Save to trades collection
        await new Promise<void>((resolve, reject) => {
            cache.insertOne('trades', tradeRecord, (err, result) => {
                if (err || !result) {
                    logger.error(`[pool-swap] Failed to record trade: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        logger.debug(`[pool-swap] Recorded trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`);
    } catch (error) {
        logger.error(`[pool-swap] Error recording trade: ${error}`);
    }
}

export async function processTx(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
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
        amountIn: toDbString(toBigInt(data.amountIn)),
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
            amountIn: toDbString(toBigInt(data.amountIn)),
            amountOut: toDbString(amountOut),
            fee: toDbString(feeAmount),
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
        amountIn: toDbString(toBigInt(data.amountIn)),
        amountOut: toDbString(totalAmountOut),
        fee: toDbString(totalAmountOut * BigInt(10000) / toBigInt(data.amountIn)),
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