import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, LiquidityPool } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';

const SWAP_FEE_RATE = 0.003; // 0.3% swap fee

// Helper to parse string amounts to numbers, returns 0 if invalid
function parseAmount(amountStr: string | undefined): number {
    if (amountStr === undefined) return 0;
    const amount = parseFloat(amountStr);
    return isNaN(amount) || amount < 0 ? 0 : amount;
}

export async function validateTx(data: PoolSwapData, sender: string): Promise<boolean> {
  try {
    if (sender !== data.trader) {
      logger.warn('[pool-swap] Sender must be the trader.');
        return false;
    }

    const amountInNum = parseAmount(data.amountIn);
    if (amountInNum <= 0) {
        logger.warn('[pool-swap] amountIn must be a positive number.');
        return false;
    }
    const minAmountOutNum = parseAmount(data.minAmountOut); // Can be 0 if not specified, but if specified, must be > 0 for some interpretations.
                                                          // Current doc implies it\'s always present as string.
    if (minAmountOutNum <=0) { // If minAmountOut is required and must be positive.
         logger.warn('[pool-swap] minAmountOut must be a positive number string.');
        return false;
    }

    const traderAccount = await getAccount(data.trader);
    if (!traderAccount) {
      logger.warn(`[pool-swap] Trader account ${data.trader} not found.`);
      return false;
    }

    // Routed Swap Validation
    if (data.hops && data.hops.length > 0) {
      if (!data.fromTokenSymbol || !data.fromTokenIssuer || !data.toTokenSymbol || !data.toTokenIssuer) {
        logger.warn('[pool-swap-route] Missing fromTokenSymbol/Issuer or toTokenSymbol/Issuer for routed swap.');
        return false;
      }
      if (data.hops.length > 4) { // Max hops check
        logger.warn('[pool-swap-route] Exceeded maximum allowed hops (4).');
        return false;
      }

      const initialTokenIdentifier = `${data.fromTokenSymbol}@${data.fromTokenIssuer}`;
      const traderInitialBalance = traderAccount.balances?.[initialTokenIdentifier] || 0;
      if (traderInitialBalance < amountInNum) {
        logger.warn(`[pool-swap-route] Trader ${data.trader} has insufficient ${data.fromTokenSymbol} balance. Has ${traderInitialBalance}, needs ${amountInNum}`);
        return false;
      }

      let currentTokenSymbol = data.fromTokenSymbol;
      let currentTokenIssuer = data.fromTokenIssuer;

      for (let i = 0; i < data.hops.length; i++) {
        const hop = data.hops[i];
        if (!hop.poolId || !hop.hopTokenInSymbol || !hop.hopTokenInIssuer || !hop.hopTokenOutSymbol || !hop.hopTokenOutIssuer) {
          logger.warn(`[pool-swap-route] Invalid hop data at index ${i}. Missing fields.`);
          return false;
        }
        if (hop.hopTokenInSymbol !== currentTokenSymbol || hop.hopTokenInIssuer !== currentTokenIssuer) {
          logger.warn(`[pool-swap-route] Token mismatch at hop ${i}. Expected ${currentTokenSymbol}@${currentTokenIssuer}, got ${hop.hopTokenInSymbol}@${hop.hopTokenInIssuer}.`);
          return false;
        }

        const pool = await cache.findOnePromise('liquidityPools', { _id: hop.poolId }) as LiquidityPool | null;
        if (!pool) {
          logger.warn(`[pool-swap-route] Pool ${hop.poolId} for hop ${i} not found.`);
          return false;
        }
        // Check if pool tokens match hopTokenIn and hopTokenOut
        const hopInMatchesPoolA = pool.tokenA_symbol === hop.hopTokenInSymbol && pool.tokenA_issuer === hop.hopTokenInIssuer;
        const hopInMatchesPoolB = pool.tokenB_symbol === hop.hopTokenInSymbol && pool.tokenB_issuer === hop.hopTokenInIssuer;
        const hopOutMatchesPoolA = pool.tokenA_symbol === hop.hopTokenOutSymbol && pool.tokenA_issuer === hop.hopTokenOutIssuer;
        const hopOutMatchesPoolB = pool.tokenB_symbol === hop.hopTokenOutSymbol && pool.tokenB_issuer === hop.hopTokenOutIssuer;

        if (!((hopInMatchesPoolA && hopOutMatchesPoolB) || (hopInMatchesPoolB && hopOutMatchesPoolA))) {
            logger.warn(`[pool-swap-route] Pool ${hop.poolId} (hop ${i}) does not involve the specified hopTokenIn ${hop.hopTokenInSymbol} and hopTokenOut ${hop.hopTokenOutSymbol} pair.`);
            return false;
        }
        if (pool.tokenA_reserve <= 0 || pool.tokenB_reserve <= 0) {
            logger.warn(`[pool-swap-route] Pool ${hop.poolId} (hop ${i}) has insufficient liquidity.`);
            return false;
        }

        currentTokenSymbol = hop.hopTokenOutSymbol;
        currentTokenIssuer = hop.hopTokenOutIssuer;
      }

      if (currentTokenSymbol !== data.toTokenSymbol || currentTokenIssuer !== data.toTokenIssuer) {
        logger.warn('[pool-swap-route] Last hop output token does not match overall toTokenSymbol/Issuer.');
        return false;
      }

    } 
    // Direct Swap Validation (else if no hops or hops array is empty)
    else if (data.poolId && data.tokenInSymbol && data.tokenInIssuer && data.tokenOutSymbol && data.tokenOutIssuer) {
        if (!validate.string(data.poolId, 64, 1)) { // Max length for poolId? Assuming 64 for now.
            logger.warn('[pool-swap-direct] Invalid poolId format.');
            return false;
        }
        if (data.tokenInSymbol === data.tokenOutSymbol && data.tokenInIssuer === data.tokenOutIssuer) {
            logger.warn('[pool-swap-direct] tokenIn and tokenOut cannot be the same for a direct swap.');
            return false;
        }

        const pool = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPool | null;
        if (!pool) {
          logger.warn(`[pool-swap-direct] Pool ${data.poolId} not found.`);
          return false;
        }

        const tokenInMatchesPoolTokenA = pool.tokenA_symbol === data.tokenInSymbol && pool.tokenA_issuer === data.tokenInIssuer;
        const tokenInMatchesPoolTokenB = pool.tokenB_symbol === data.tokenInSymbol && pool.tokenB_issuer === data.tokenInIssuer;
        const tokenOutMatchesPoolTokenA = pool.tokenA_symbol === data.tokenOutSymbol && pool.tokenA_issuer === data.tokenOutIssuer;
        const tokenOutMatchesPoolTokenB = pool.tokenB_symbol === data.tokenOutSymbol && pool.tokenB_issuer === data.tokenOutIssuer;

        if (!((tokenInMatchesPoolTokenA && tokenOutMatchesPoolTokenB) || (tokenInMatchesPoolTokenB && tokenOutMatchesPoolTokenA))) {
            logger.warn(`[pool-swap-direct] Pool ${data.poolId} does not involve the specified tokenIn ${data.tokenInSymbol} and tokenOut ${data.tokenOutSymbol} pair.`);
            return false;
        }
        if (pool.tokenA_reserve <= 0 || pool.tokenB_reserve <= 0) {
            logger.warn(`[pool-swap-direct] Pool ${data.poolId} has insufficient liquidity.`);
            return false;
        }
        const tokenInIdentifier = `${data.tokenInSymbol}@${data.tokenInIssuer}`;
    const traderTokenInBalance = traderAccount.balances?.[tokenInIdentifier] || 0;
        if (traderTokenInBalance < amountInNum) {
          logger.warn(`[pool-swap-direct] Trader ${data.trader} has insufficient ${data.tokenInSymbol} balance. Has ${traderTokenInBalance}, needs ${amountInNum}`);
          return false;
        }
    } 
    // Invalid structure - neither valid routed nor valid direct
    else {
        logger.warn('[pool-swap] Invalid data structure: Must provide valid hops for a routed swap or poolId & token details for a direct swap.');
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
    return false;
  }
}

// Helper to calculate swap output amount (constant product formula with fee)
function calculateSwapAmountOut(
    amountIn: number,
    reserveIn: number,
    reserveOut: number,
    poolFeeRate: number // Use specific pool's fee rate
): number {
    if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
    const amountInAfterFee = amountIn * (1 - poolFeeRate);
    const numerator = reserveOut * amountInAfterFee;
    const denominator = reserveIn + amountInAfterFee;
    if (denominator === 0) return 0;
    return numerator / denominator;
}

export async function process(data: PoolSwapData, sender: string): Promise<boolean> {
  const amountInNum = parseAmount(data.amountIn);
  const minAmountOutNum = parseAmount(data.minAmountOut);

  // Routed Swap Processing
  if (data.hops && data.hops.length > 0) {
    if (!data.fromTokenSymbol || !data.fromTokenIssuer || !data.toTokenSymbol || !data.toTokenIssuer) {
        logger.error('[pool-swap-route] CRITICAL: Missing from/to token details in process. Should be caught by validation.');
        return false;
    }
    let currentTokenAmount = amountInNum;
    const initialTokenIdentifier = `${data.fromTokenSymbol}@${data.fromTokenIssuer}`;

    // 1. Debit initial token from trader
    if (!await adjustBalance(data.trader, initialTokenIdentifier, -amountInNum)) {
        logger.error(`[pool-swap-route] Failed to debit ${amountInNum} ${initialTokenIdentifier} from ${data.trader}.`);
      return false;
    }

    const processedPoolsInfo: Array<{pool: LiquidityPool, originalReserveIn: number, originalReserveOut: number, hopTokenInSymbol: string, hopTokenInIssuer: string}> = [];

    try {
      for (let i = 0; i < data.hops.length; i++) {
        const hop = data.hops[i];
        const pool = await cache.findOnePromise('liquidityPools', { _id: hop.poolId }) as LiquidityPool | null;
        if (!pool) {
          logger.error(`[pool-swap-route] CRITICAL: Pool ${hop.poolId} for hop ${i} not found during processing.`);
          throw new Error(`Pool ${hop.poolId} not found for hop ${i}`);
    }

    let reserveIn: number, reserveOut: number;
        if (pool.tokenA_symbol === hop.hopTokenInSymbol && pool.tokenA_issuer === hop.hopTokenInIssuer) {
      reserveIn = pool.tokenA_reserve;
      reserveOut = pool.tokenB_reserve;
        } else if (pool.tokenB_symbol === hop.hopTokenInSymbol && pool.tokenB_issuer === hop.hopTokenInIssuer) {
      reserveIn = pool.tokenB_reserve;
      reserveOut = pool.tokenA_reserve;
        } else {
          logger.error(`[pool-swap-route] CRITICAL: Mismatch in hopTokenInSymbol for pool ${hop.poolId} (hop ${i}).`);
          throw new Error(`Token mismatch in hop ${i}`);
        }
        
        // Store original reserves for potential rollback of this hop
        processedPoolsInfo.push({ pool, originalReserveIn: reserveIn, originalReserveOut: reserveOut, hopTokenInSymbol: hop.hopTokenInSymbol, hopTokenInIssuer: hop.hopTokenInIssuer });


        const hopAmountOut = calculateSwapAmountOut(currentTokenAmount, reserveIn, reserveOut, pool.feeRate || SWAP_FEE_RATE); // Use pool.feeRate
        if (hopAmountOut <= 0) {
          logger.warn(`[pool-swap-route] Hop ${i} (${hop.poolId}) output is ${hopAmountOut}. Route not viable.`);
          throw new Error(`Hop ${i} output is zero or less.`);
        }

        const newReserveIn = reserveIn + currentTokenAmount;
        const newReserveOut = reserveOut - hopAmountOut;

        let poolUpdateChanges = {};
        if (pool.tokenA_symbol === hop.hopTokenInSymbol && pool.tokenA_issuer === hop.hopTokenInIssuer) {
            poolUpdateChanges = { tokenA_reserve: newReserveIn, tokenB_reserve: newReserveOut };
        } else {
            poolUpdateChanges = { tokenB_reserve: newReserveIn, tokenA_reserve: newReserveOut };
        }
        
        const poolUpdateSuccess = await cache.updateOnePromise(
          'liquidityPools',
          { _id: hop.poolId },
          { $set: { ...poolUpdateChanges, lastUpdatedAt: new Date().toISOString() } }
        );

        if (!poolUpdateSuccess) {
          logger.error(`[pool-swap-route] CRITICAL: Failed to update pool reserves for ${hop.poolId} (hop ${i}).`);
          throw new Error(`Failed to update pool ${hop.poolId} at hop ${i}`);
        }
        currentTokenAmount = hopAmountOut; // Output of this hop is input for the next
      }

      // After all hops, currentTokenAmount is the final amountOut
      if (currentTokenAmount < minAmountOutNum) {
        logger.warn(`[pool-swap-route] Slippage protection: Final amountOut ${currentTokenAmount} is less than minAmountOut ${minAmountOutNum}.`);
        throw new Error('Slippage protection triggered.');
      }

      // 2. Credit final token to trader
      const finalTokenIdentifier = `${data.toTokenSymbol}@${data.toTokenIssuer}`;
      if (!await adjustBalance(data.trader, finalTokenIdentifier, currentTokenAmount)) {
        logger.error(`[pool-swap-route] CRITICAL: Failed to credit ${currentTokenAmount} ${finalTokenIdentifier} to ${data.trader}.`);
        throw new Error('Failed to credit final tokens.'); // This will trigger rollback
      }

      logger.info(`[pool-swap-route] Trader ${data.trader} routed swap ${data.amountIn} ${data.fromTokenSymbol} for ${currentTokenAmount.toFixed(8)} ${data.toTokenSymbol} via ${data.hops.length} hops.`);
      const eventDocument = {
        type: 'poolRouteSwap', // Differentiate event type
        timestamp: new Date().toISOString(),
        actor: sender,
        data: { ...data, finalAmountOut: currentTokenAmount, amountIn: amountInNum, minAmountOut: minAmountOutNum } // Log parsed numbers too
      };
      // Fire and forget for logging
      cache.insertOne('events', eventDocument, (err) => {
          if (err) logger.error(`[pool-swap-route] CRITICAL: Failed to log poolRouteSwap event: ${err}`);
      });

      return true;

    } catch (routeError: any) {
      logger.error(`[pool-swap-route] Error during routed swap processing: ${routeError.message}. Attempting rollback.`);
      // Rollback main debit
      await adjustBalance(data.trader, initialTokenIdentifier, amountInNum);
      // Rollback pool updates in reverse order of processing
      for (let j = processedPoolsInfo.length - 1; j >= 0; j--) {
        const info = processedPoolsInfo[j];
        let previousPoolUpdateChanges = {};
         if (info.pool.tokenA_symbol === info.hopTokenInSymbol && info.pool.tokenA_issuer === info.hopTokenInIssuer) {
            previousPoolUpdateChanges = { tokenA_reserve: info.originalReserveIn, tokenB_reserve: info.originalReserveOut };
    } else {
            previousPoolUpdateChanges = { tokenB_reserve: info.originalReserveIn, tokenA_reserve: info.originalReserveOut };
        }
        await cache.updateOnePromise('liquidityPools', { _id: info.pool._id }, { $set: previousPoolUpdateChanges });
        logger.info(`[pool-swap-route] Rolled back reserves for pool ${info.pool._id}`);
      }
      return false;
    }
  }
  // Direct Swap Processing (else if no hops defined or empty)
  else if (data.poolId && data.tokenInSymbol && data.tokenInIssuer && data.tokenOutSymbol && data.tokenOutIssuer) {
    try {
        const pool = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPool | null;
        if (!pool) {
          logger.error(`[pool-swap-direct] CRITICAL: Pool ${data.poolId} not found during processing.`);
      return false;
    }
    
        let reserveIn: number, reserveOut: number;
        // Determine which pool token is tokenIn and which is tokenOut
        if (pool.tokenA_symbol === data.tokenInSymbol && pool.tokenA_issuer === data.tokenInIssuer) {
          reserveIn = pool.tokenA_reserve;
          reserveOut = pool.tokenB_reserve;
        } else if (pool.tokenB_symbol === data.tokenInSymbol && pool.tokenB_issuer === data.tokenInIssuer) {
          reserveIn = pool.tokenB_reserve;
          reserveOut = pool.tokenA_reserve;
        } else {
          logger.error(`[pool-swap-direct] CRITICAL: Mismatch in tokenIn for pool ${data.poolId}.`);
        return false;
    }

    if (reserveIn <= 0 || reserveOut <= 0) {
            logger.error(`[pool-swap-direct] CRITICAL: Pool ${data.poolId} has zero or negative reserve.`);
        return false;
    }

        const amountOut = calculateSwapAmountOut(amountInNum, reserveIn, reserveOut, pool.feeRate || SWAP_FEE_RATE); // Use pool.feeRate

    if (amountOut <= 0) {
          logger.warn(`[pool-swap-direct] Calculated amountOut is ${amountOut}. Swap not viable.`);
      return false;
    }
        if (minAmountOutNum > 0 && amountOut < minAmountOutNum) {
          logger.warn(`[pool-swap-direct] Slippage protection: Calculated amountOut ${amountOut} is less than minAmountOut ${minAmountOutNum}.`);
      return false;
    }

        const tokenInIdentifier = `${data.tokenInSymbol}@${data.tokenInIssuer}`;
        if (!await adjustBalance(data.trader, tokenInIdentifier, -amountInNum)) {
            logger.error(`[pool-swap-direct] Failed to debit ${amountInNum} ${tokenInIdentifier} from ${data.trader}.`);
        return false;
    }

        const newReserveIn = reserveIn + amountInNum;
    const newReserveOut = reserveOut - amountOut;

    let poolUpdateChanges = {};
        if (pool.tokenA_symbol === data.tokenInSymbol && pool.tokenA_issuer === data.tokenInIssuer) {
        poolUpdateChanges = { tokenA_reserve: newReserveIn, tokenB_reserve: newReserveOut };
    } else {
        poolUpdateChanges = { tokenB_reserve: newReserveIn, tokenA_reserve: newReserveOut };
    }

    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: data.poolId },
      { $set: { ...poolUpdateChanges, lastUpdatedAt: new Date().toISOString() } }
    );

    if (!poolUpdateSuccess) {
          logger.error(`[pool-swap-direct] CRITICAL: Failed to update pool reserves for ${data.poolId}. Rolling back debit.`);
          await adjustBalance(data.trader, tokenInIdentifier, amountInNum);
      return false;
    }

        const tokenOutIdentifier = `${data.tokenOutSymbol}@${data.tokenOutIssuer}`;
    if (!await adjustBalance(data.trader, tokenOutIdentifier, amountOut)) {
            logger.error(`[pool-swap-direct] CRITICAL: Failed to credit ${amountOut} ${tokenOutIdentifier} to ${data.trader}. State inconsistent!`);
            await adjustBalance(data.trader, tokenInIdentifier, amountInNum); // Rollback debit
            let previousPoolUpdateChanges = {}; // Rollback pool
            if (pool.tokenA_symbol === data.tokenInSymbol && pool.tokenA_issuer === data.tokenInIssuer) {
            previousPoolUpdateChanges = { tokenA_reserve: reserveIn, tokenB_reserve: reserveOut };
        } else {
            previousPoolUpdateChanges = { tokenB_reserve: reserveIn, tokenA_reserve: reserveOut };
        }
        await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, { $set: previousPoolUpdateChanges });
        return false;
    }

        logger.info(`[pool-swap-direct] Trader ${data.trader} swapped ${amountInNum.toFixed(8)} ${data.tokenInSymbol} for ${amountOut.toFixed(8)} ${data.tokenOutSymbol} in pool ${data.poolId}.`);

    const eventDocument = {
          type: 'poolDirectSwap', // Differentiate event type
      timestamp: new Date().toISOString(),
      actor: sender,
          data: { ...data, tokenIn_amount: amountInNum, minTokenOut_amount: minAmountOutNum, tokenOut_amount: amountOut } // Log actual processed amounts
        };
        cache.insertOne('events', eventDocument, (err) => {
            if (err) logger.error(`[pool-swap-direct] CRITICAL: Failed to log poolDirectSwap event: ${err}`);
        });
    return true;

      } catch (directError: any) {
        logger.error(`[pool-swap-direct] Error processing direct swap: ${directError.message}`);
        return false;
      }
  }
  // Neither routed nor direct payload structure matched
  else {
    logger.error('[pool-swap] CRITICAL: Data structure did not match routed or direct swap criteria in process function. This should be caught by validation.');
    return false;
  }
} 