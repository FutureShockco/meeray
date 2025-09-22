import logger from '../../logger.js';
import cache from '../../cache.js';
import { PoolAddLiquidityData, LiquidityPoolData } from './pool-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { calculateLpTokensToMint } from '../../utils/pool.js';
import {
  validatePoolAddLiquidityFields,
  poolExists,
  validateUserBalances,
  validatePoolRatioTolerance,
  validateLpTokenExists
} from '../../validation/pool.js';
import {
  debitLiquidityTokens,
  updatePoolReserves,
  updateUserLiquidityPosition,
  creditLpTokens
} from './pool-helpers.js';

export async function validateTx(data: PoolAddLiquidityData, sender: string): Promise<boolean> {
  try {
    // Validate required fields and sender
    if (!validatePoolAddLiquidityFields(data, sender)) {
      return false;
    }

    // Validate pool exists
    const pool = await poolExists(data.poolId);
    if (!pool) {
      return false;
    }

    // Validate user balances
    if (!await validateUserBalances(sender, pool.tokenA_symbol, pool.tokenB_symbol, data.tokenA_amount, data.tokenB_amount)) {
      return false;
    }

    // Validate pool ratio tolerance
    if (!validatePoolRatioTolerance(pool, data.tokenA_amount, data.tokenB_amount)) {
      return false;
    }

    // Validate LP token exists
    if (!await validateLpTokenExists(pool.tokenA_symbol, pool.tokenB_symbol, data.poolId)) {
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error validating add liquidity data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function processTx(data: PoolAddLiquidityData, sender: string, id: string): Promise<boolean> {
  try {
    const poolDB = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolData; // validateTx guarantees existence

    // Prepare pool data with fee accounting fields
    const pool = {
      ...poolDB,
      feeGrowthGlobalA: toBigInt(poolDB.feeGrowthGlobalA || '0'),
      feeGrowthGlobalB: toBigInt(poolDB.feeGrowthGlobalB || '0')
    };

    // Debit tokens from the provider's account
    if (!await debitLiquidityTokens(sender, pool.tokenA_symbol, pool.tokenB_symbol, data.tokenA_amount, data.tokenB_amount)) {
      return false;
    }

    // Calculate LP tokens to mint
    const lpTokensToMint = calculateLpTokensToMint(toBigInt(data.tokenA_amount), toBigInt(data.tokenB_amount), pool);
    if (lpTokensToMint <= BigInt(0)) {
      logger.error('[pool-add-liquidity] CRITICAL: LP token calculation resulted in zero or negative amount.');
      return false;
    }

    // Update pool reserves and total LP tokens
    if (!await updatePoolReserves(data.poolId, pool, data.tokenA_amount, data.tokenB_amount, lpTokensToMint)) {
      return false;
    }

    // Update or create user liquidity position
    if (!await updateUserLiquidityPosition(sender, data.poolId, lpTokensToMint, pool)) {
      return false;
    }

    // Credit LP tokens to user account
    if (!await creditLpTokens(sender, pool.tokenA_symbol, pool.tokenB_symbol, lpTokensToMint, data.poolId)) {
      return false;
    }

    logger.debug(`[pool-add-liquidity] Provider ${sender} added liquidity to pool ${data.poolId}. Token A: ${data.tokenA_amount}, Token B: ${data.tokenB_amount}, LP tokens minted: ${lpTokensToMint}`);

    // Log event
    await logEvent('defi', 'liquidity_added', sender, {
      poolId: data.poolId,
      tokenAAmount: toDbString(data.tokenA_amount),
      tokenBAmount: toDbString(data.tokenB_amount),
      lpTokensMinted: toDbString(lpTokensToMint)
    }, id);

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}