import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolRemoveLiquidityData, LiquidityPool, UserLiquidityPosition } from './pool-interfaces.js';
import { adjustBalance, getAccount } from '../../utils/account-utils.js';

export async function validateTx(data: PoolRemoveLiquidityData, sender: string): Promise<boolean> {
  try {
    if (!data.poolId || !data.provider || data.lpTokenAmount === undefined) {
      logger.warn('[pool-remove-liquidity] Invalid data: Missing required fields (poolId, provider, lpTokenAmount).');
      return false;
    }
    if (sender !== data.provider) {
      logger.warn('[pool-remove-liquidity] Sender must be the liquidity provider whose LP tokens are being burned.');
      return false;
    }
    if (!validate.string(data.poolId, 64, 1)) {
        logger.warn('[pool-remove-liquidity] Invalid poolId format.');
        return false;
    }
    if (!validate.integer(data.lpTokenAmount, false, false, undefined, 0) || data.lpTokenAmount <= 0) {
        logger.warn('[pool-remove-liquidity] lpTokenAmount must be a positive number.');
        return false;
    }

    const pool = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPool | null;
    if (!pool) {
      logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} not found.`);
      return false;
    }
    if (pool.totalLpTokens === 0) {
        logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} has no liquidity to remove.`);
        return false;
    }

    const userLpPositionId = `${data.provider}-${data.poolId}`;
    const userPosition = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPosition | null;
    if (!userPosition || userPosition.lpTokenBalance < data.lpTokenAmount) {
      logger.warn(`[pool-remove-liquidity] Provider ${data.provider} has insufficient LP token balance for pool ${data.poolId}. Has ${userPosition?.lpTokenBalance || 0}, needs ${data.lpTokenAmount}`);
      return false;
    }

    // Optional: Check against minTokenA_amount and minTokenB_amount if provided (slippage protection for removal)

    return true;
  } catch (error) {
    logger.error(`[pool-remove-liquidity] Error validating data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: PoolRemoveLiquidityData, sender: string): Promise<boolean> {
  try {
    const pool = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPool | null;
    if (!pool) {
      logger.error(`[pool-remove-liquidity] CRITICAL: Pool ${data.poolId} not found during processing. Validation might be stale.`);
      return false;
    }

    const userLpPositionId = `${data.provider}-${data.poolId}`;
    const userPosition = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPosition | null;
    if (!userPosition || userPosition.lpTokenBalance < data.lpTokenAmount) {
      logger.error(`[pool-remove-liquidity] CRITICAL: User position ${userLpPositionId} not found or insufficient LP balance during processing.`);
      return false; 
    }

    // Calculate amounts of tokenA and tokenB to return
    // share = lpTokenAmount / totalLpTokens
    // amountTokenA = share * reserveTokenA
    // amountTokenB = share * reserveTokenB
    const shareOfPool = data.lpTokenAmount / pool.totalLpTokens;
    const tokenAAmountToReturn = shareOfPool * pool.tokenA_reserve;
    const tokenBAmountToReturn = shareOfPool * pool.tokenB_reserve;

    if (tokenAAmountToReturn <= 0 || tokenBAmountToReturn <= 0) {
        logger.error(`[pool-remove-liquidity] Calculated zero or negative tokens to return for ${data.poolId}. LP: ${data.lpTokenAmount}, TotalLP: ${pool.totalLpTokens}, ResA: ${pool.tokenA_reserve}, ResB: ${pool.tokenB_reserve}`);
        return false;
    }

    // 1. Update pool reserves and total LP tokens (decrease)
    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: data.poolId },
      {
        $inc: {
          tokenA_reserve: -tokenAAmountToReturn,
          tokenB_reserve: -tokenBAmountToReturn,
          totalLpTokens: -data.lpTokenAmount
        },
        $set: { lastUpdatedAt: new Date().toISOString() }
      }
    );

    if (!poolUpdateSuccess) {
      logger.error(`[pool-remove-liquidity] Failed to update pool reserves for ${data.poolId}. Cannot proceed.`);
      return false;
    }

    // 2. Update user's LP token balance (decrease)
    const newLpBalance = userPosition.lpTokenBalance - data.lpTokenAmount;
    const userPositionUpdateSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpPositionId },
        { 
            $set: { 
                lpTokenBalance: newLpBalance, 
                lastUpdatedAt: new Date().toISOString() 
            }
        }
    );

    if (!userPositionUpdateSuccess) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to update user LP position ${userLpPositionId}. Pool reserves changed! Manual rollback/fix needed for pool and user LP balance.`);
        // Attempt to roll back pool changes
        await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
            $inc: { tokenA_reserve: tokenAAmountToReturn, tokenB_reserve: tokenBAmountToReturn, totalLpTokens: data.lpTokenAmount }
        });
        return false;
    }

    // 3. Credit tokenA and tokenB back to the provider's account
    const tokenAIdentifier = `${pool.tokenA_symbol}@${pool.tokenA_issuer}`;
    const tokenBIdentifier = `${pool.tokenB_symbol}@${pool.tokenB_issuer}`;

    if (!await adjustBalance(data.provider, tokenAIdentifier, tokenAAmountToReturn)) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${tokenAAmountToReturn} ${tokenAIdentifier} to ${data.provider}. State inconsistent! Manual fix needed.`);
        // At this point, pool and user LP are updated, but user didn't get token A.
        // Rollbacks are getting very complex. Need robust transaction management or flagging.
        return false; 
    }
    if (!await adjustBalance(data.provider, tokenBIdentifier, tokenBAmountToReturn)) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${tokenBAmountToReturn} ${tokenBIdentifier} to ${data.provider}. User received Token A but not B. State inconsistent! Manual fix needed.`);
        // User got token A, but not token B. Further complex rollback or flagging.
        await adjustBalance(data.provider, tokenAIdentifier, -tokenAAmountToReturn); // Try to roll back token A credit.
        return false;
    }

    logger.debug(`[pool-remove-liquidity] ${data.provider} removed liquidity from pool ${data.poolId} by burning ${data.lpTokenAmount} LP tokens. Received ${tokenAAmountToReturn.toFixed(8)} ${pool.tokenA_symbol} and ${tokenBAmountToReturn.toFixed(8)} ${pool.tokenB_symbol}.`);

    // Log event
    const eventDocument = {
      type: 'poolRemoveLiquidity',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        poolId: data.poolId,
        provider: data.provider,
        lpTokensBurned: data.lpTokenAmount,
        tokenA_symbol: pool.tokenA_symbol,
        tokenA_issuer: pool.tokenA_issuer,
        tokenA_amount_returned: tokenAAmountToReturn,
        tokenB_symbol: pool.tokenB_symbol,
        tokenB_issuer: pool.tokenB_issuer,
        tokenB_amount_returned: tokenBAmountToReturn
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => { 
            if (err || !result) {
                logger.error(`[pool-remove-liquidity] CRITICAL: Failed to log poolRemoveLiquidity event for ${data.poolId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[pool-remove-liquidity] Error processing remove liquidity for pool ${data.poolId} by ${sender}: ${error}`);
    // General catch block, rollbacks would be very complex here and depend on which step failed.
    // The specific rollbacks are attempted in the steps above.
    return false;
  }
} 