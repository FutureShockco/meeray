import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolAddLiquidityData, LiquidityPool, UserLiquidityPosition } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';

// Helper to calculate LP tokens to mint
// This is a simplified version. Real AMMs use more complex formulas (e.g., Uniswap v2: sqrt(dx*dy) for first provider, or proportional for subsequent)
function calculateLpTokensToMint(
  tokenA_amount: number,
  tokenB_amount: number,
  pool: LiquidityPool
): number {
  if (pool.totalLpTokens === 0) {
    // First liquidity provider, LP tokens can be based on the geometric mean of amounts or a fixed initial amount
    // Let's use Math.sqrt(tokenA_amount * tokenB_amount) as a common starting point.
    // IMPORTANT: This needs to be a large enough number to avoid precision issues with small initial deposits.
    return Math.sqrt(tokenA_amount * tokenB_amount); 
  } else {
    // Subsequent provider, mint LP tokens proportional to their share of the pool
    const ratioA = (tokenA_amount / pool.tokenA_reserve) * pool.totalLpTokens;
    const ratioB = (tokenB_amount / pool.tokenB_reserve) * pool.totalLpTokens;
    return (ratioA + ratioB) / 2; // Average to mitigate slight discrepancies if ratio isn't perfect
  }
}

export async function validateTx(data: PoolAddLiquidityData, sender: string): Promise<boolean> {
  try {
    if (!data.poolId || !data.provider || data.tokenA_amount === undefined || data.tokenB_amount === undefined) {
      logger.warn('[pool-add-liquidity] Invalid data: Missing required fields (poolId, provider, tokenA_amount, tokenB_amount).');
      return false;
    }
    if (sender !== data.provider) {
      logger.warn('[pool-add-liquidity] Sender must be the liquidity provider.');
      return false;
    }
    if (!validate.string(data.poolId, 64, 1)) { 
        logger.warn('[pool-add-liquidity] Invalid poolId format.');
        return false;
    }
    if (!validate.integer(data.tokenA_amount, false, false, undefined, 0) || data.tokenA_amount <= 0) {
        logger.warn('[pool-add-liquidity] tokenA_amount must be a positive number.');
        return false;
    }
    if (!validate.integer(data.tokenB_amount, false, false, undefined, 0) || data.tokenB_amount <= 0) {
        logger.warn('[pool-add-liquidity] tokenB_amount must be a positive number.');
        return false;
    }

    const poolFromCache = await cache.findOnePromise('liquidityPools', { _id: data.poolId });
    if (!poolFromCache) {
      logger.warn(`[pool-add-liquidity] Pool ${data.poolId} not found.`);
      return false;
    }
    const pool = poolFromCache as LiquidityPool;

    const providerAccount: Account | null = await getAccount(data.provider);
    if (!providerAccount) {
      logger.warn(`[pool-add-liquidity] Provider account ${data.provider} not found.`);
      return false;
    }

    const tokenAIdentifier = `${pool.tokenA_symbol}@${pool.tokenA_issuer}`;
    const tokenBIdentifier = `${pool.tokenB_symbol}@${pool.tokenB_issuer}`;
    const tokenABalance = providerAccount.balances?.[tokenAIdentifier] || 0;
    if (tokenABalance < data.tokenA_amount) {
      logger.warn(`[pool-add-liquidity] Provider ${data.provider} has insufficient ${pool.tokenA_symbol} balance. Has ${tokenABalance}, needs ${data.tokenA_amount}`);
      return false;
    }
    const tokenBBalance = providerAccount.balances?.[tokenBIdentifier] || 0;
    if (tokenBBalance < data.tokenB_amount) {
      logger.warn(`[pool-add-liquidity] Provider ${data.provider} has insufficient ${pool.tokenB_symbol} balance. Has ${tokenBBalance}, needs ${data.tokenB_amount}`);
      return false;
    }

    if (pool.tokenA_reserve > 0 && pool.tokenB_reserve > 0) {
      const expectedTokenBAmount = (data.tokenA_amount / pool.tokenA_reserve) * pool.tokenB_reserve;
      const tolerance = 0.001; 
      if (Math.abs(data.tokenB_amount - expectedTokenBAmount) / Math.max(expectedTokenBAmount, 1e-9) > tolerance) {
        logger.warn(`[pool-add-liquidity] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount.toFixed(6)}, Got: ${data.tokenB_amount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${data.tokenA_amount}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error validating data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: PoolAddLiquidityData, sender: string): Promise<boolean> {
  try {
    const poolFromCache = await cache.findOnePromise('liquidityPools', { _id: data.poolId });
    if (!poolFromCache) {
      logger.error(`[pool-add-liquidity] CRITICAL: Pool ${data.poolId} not found during processing. Validation might be stale.`);
      return false;
    }
    const pool = poolFromCache as LiquidityPool;

    const tokenAIdentifier = `${pool.tokenA_symbol}@${pool.tokenA_issuer}`;
    const tokenBIdentifier = `${pool.tokenB_symbol}@${pool.tokenB_issuer}`;

    if (!await adjustBalance(data.provider, tokenAIdentifier, -data.tokenA_amount)) {
        logger.error(`[pool-add-liquidity] Failed to debit ${data.tokenA_amount} ${tokenAIdentifier} from ${data.provider}.`);
        return false;
    }
    if (!await adjustBalance(data.provider, tokenBIdentifier, -data.tokenB_amount)) {
        logger.error(`[pool-add-liquidity] Failed to debit ${data.tokenB_amount} ${tokenBIdentifier} from ${data.provider}. Rolling back token A debit.`);
        await adjustBalance(data.provider, tokenAIdentifier, data.tokenA_amount); 
        return false;
    }

    const lpTokensToMint = calculateLpTokensToMint(data.tokenA_amount, data.tokenB_amount, pool);
    if (lpTokensToMint <= 0) {
        logger.error(`[pool-add-liquidity] Calculated LP tokens to mint is zero or negative for ${data.poolId}.`);
        await adjustBalance(data.provider, tokenAIdentifier, data.tokenA_amount); 
        await adjustBalance(data.provider, tokenBIdentifier, data.tokenB_amount); 
        return false;
    }

    const poolUpdateData = {
        $inc: {
          tokenA_reserve: data.tokenA_amount,
          tokenB_reserve: data.tokenB_amount,
          totalLpTokens: lpTokensToMint
        },
        $set: { lastUpdatedAt: new Date().toISOString() }
    };

    const updateResult = await cache.updateOnePromise(
        'liquidityPools',
        { _id: data.poolId },
        poolUpdateData
    );

    if (!updateResult) {
      logger.error(`[pool-add-liquidity] Failed to update pool reserves for ${data.poolId}. Rolling back balances.`);
      await adjustBalance(data.provider, tokenAIdentifier, data.tokenA_amount); 
      await adjustBalance(data.provider, tokenBIdentifier, data.tokenB_amount); 
      return false;
    }

    const userLpPositionId = `${data.provider}-${data.poolId}`;
    const userPositionUpdateSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpPositionId },
        {
            $inc: { lpTokenBalance: lpTokensToMint },
            $setOnInsert: { 
                provider: data.provider, 
                poolId: data.poolId,
                createdAt: new Date().toISOString() 
            },
            $set: { lastUpdatedAt: new Date().toISOString() },
            upsert: true
        }
    );

    if (!userPositionUpdateSuccess) {
        logger.error(`[pool-add-liquidity] CRITICAL: Failed to update user LP position ${userLpPositionId}. Pool updated, but user LP tokens not credited. Manual fix needed.`);
    }

    logger.debug(`[pool-add-liquidity] ${data.provider} added ${data.tokenA_amount} ${pool.tokenA_symbol} and ${data.tokenB_amount} ${pool.tokenB_symbol} to pool ${data.poolId}. Minted ${lpTokensToMint.toFixed(8)} LP tokens.`);

    const eventDocument = {
      type: 'poolAddLiquidity',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        poolId: data.poolId,
        provider: data.provider,
        tokenA_symbol: pool.tokenA_symbol,
        tokenA_issuer: pool.tokenA_issuer,
        tokenA_amount: data.tokenA_amount,
        tokenB_symbol: pool.tokenB_symbol,
        tokenB_issuer: pool.tokenB_issuer,
        tokenB_amount: data.tokenB_amount,
        lpTokensMinted: lpTokensToMint
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[pool-add-liquidity] CRITICAL: Failed to log poolAddLiquidity event for ${data.poolId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${data.poolId} by ${sender}: ${error}`);
    const poolFromCacheOnError = await cache.findOnePromise('liquidityPools', { _id: data.poolId });
    if (poolFromCacheOnError) {
        const poolForRollback = poolFromCacheOnError as LiquidityPool;
        const tokenAIdentifier = `${poolForRollback.tokenA_symbol}@${poolForRollback.tokenA_issuer}`;
        const tokenBIdentifier = `${poolForRollback.tokenB_symbol}@${poolForRollback.tokenB_issuer}`;
        logger.debug(`[pool-add-liquidity] Attempting rollback of balances for ${sender} due to error.`);
        await adjustBalance(data.provider, tokenAIdentifier, data.tokenA_amount);
        await adjustBalance(data.provider, tokenBIdentifier, data.tokenB_amount);
    }
    return false;
  }
} 