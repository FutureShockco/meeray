import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolRemoveLiquidityData, LiquidityPool, UserLiquidityPosition, PoolRemoveLiquidityDataDB, LiquidityPoolDB, UserLiquidityPositionDB } from './pool-interfaces.js';
import { adjustBalance, getAccount } from '../../utils/account-utils.js';
import { BigIntMath, toString, toBigInt, convertToBigInt, convertToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

// minTokenA_amount and minTokenB_amount are for client-side slippage, not direct processing here if only lpTokenAmount is used.
const NUMERIC_FIELDS_REMOVE_LIQ: Array<keyof PoolRemoveLiquidityData> = ['lpTokenAmount']; 

export async function validateTx(dataDb: PoolRemoveLiquidityDataDB, sender: string): Promise<boolean> {
  // data.minTokenA_amount and data.minTokenB_amount might be present in dataDb if sent by client,
  // but convertToBigInt will only process 'lpTokenAmount' as per NUMERIC_FIELDS_REMOVE_LIQ.
  // If validation based on minTokenA_amount/minTokenB_amount is needed server-side, they should be handled explicitly.
  const data = convertToBigInt<PoolRemoveLiquidityData>(dataDb, NUMERIC_FIELDS_REMOVE_LIQ);
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
    if (!validate.bigint(data.lpTokenAmount, false, false, undefined, BigInt(1))) { 
        logger.warn('[pool-remove-liquidity] lpTokenAmount must be a positive BigInt.');
        return false;
    }
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
      logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} not found.`);
      return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);
    if (pool.totalLpTokens === BigInt(0)) {
        logger.warn(`[pool-remove-liquidity] Pool ${data.poolId} has no liquidity to remove.`);
        return false;
    }
    const userLpPositionId = `${data.provider}-${data.poolId}`;
    const userPositionFromDb = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPositionDB | null;
    if (!userPositionFromDb) {
      logger.warn(`[pool-remove-liquidity] Provider ${data.provider} has no LP position for pool ${data.poolId}.`);
      return false;
    }
    const userPosition = convertToBigInt<UserLiquidityPosition>(userPositionFromDb, ['lpTokenBalance']);
    if (userPosition.lpTokenBalance < data.lpTokenAmount) {
      logger.warn(`[pool-remove-liquidity] Provider ${data.provider} has insufficient LP token balance for pool ${data.poolId}. Has ${toString(userPosition.lpTokenBalance)}, needs ${toString(data.lpTokenAmount)}`);
      return false;
    }
    // TODO: Optional server-side validation for minTokenA_amount and minTokenB_amount from dataDb if needed
    return true;
  } catch (error) {
    logger.error(`[pool-remove-liquidity] Error validating data for pool ${dataDb.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(dataDb: PoolRemoveLiquidityDataDB, sender: string, transactionId: string): Promise<boolean> {
  // Only convert lpTokenAmount as defined in NUMERIC_FIELDS_REMOVE_LIQ for the core data object.
  // minTokenA_amount/minTokenB_amount from dataDb would be ignored by this specific convertToBigInt call if not in NUMERIC_FIELDS_REMOVE_LIQ
  const data = convertToBigInt<PoolRemoveLiquidityData>(dataDb, NUMERIC_FIELDS_REMOVE_LIQ);
  try {
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
      logger.error(`[pool-remove-liquidity] CRITICAL: Pool ${data.poolId} not found during processing.`);
      return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);

    const userLpPositionId = `${data.provider}-${data.poolId}`;
    const userPositionFromDb = await cache.findOnePromise('userLiquidityPositions', { _id: userLpPositionId }) as UserLiquidityPositionDB | null;
    if (!userPositionFromDb) {
      logger.error(`[pool-remove-liquidity] CRITICAL: User position ${userLpPositionId} not found during processing.`);
      return false; 
    }
    const userPosition = convertToBigInt<UserLiquidityPosition>(userPositionFromDb, ['lpTokenBalance']);
    if (userPosition.lpTokenBalance < data.lpTokenAmount) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Insufficient LP balance for ${userLpPositionId} during processing.`);
        return false;
    }

    const tokenAAmountToReturn = (data.lpTokenAmount * pool.tokenA_reserve) / pool.totalLpTokens;
    const tokenBAmountToReturn = (data.lpTokenAmount * pool.tokenB_reserve) / pool.totalLpTokens;

    if (tokenAAmountToReturn <= BigInt(0) || tokenBAmountToReturn <= BigInt(0)) {
        logger.error(`[pool-remove-liquidity] Calculated zero or negative tokens to return for ${data.poolId}.`);
        return false;
    }

    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: data.poolId },
      {
        $set: convertToString(
            {
                tokenA_reserve: pool.tokenA_reserve - tokenAAmountToReturn,
                tokenB_reserve: pool.tokenB_reserve - tokenBAmountToReturn,
                totalLpTokens: pool.totalLpTokens - data.lpTokenAmount,
                // lastUpdatedAt should be part of the object passed to convertToString if we want it converted (it's not a BigInt though)
                // For simplicity, setting it directly if not part of a consistent numeric conversion strategy
            },
            ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']
        ),
        // If lastUpdatedAt is always just set, no need to include in convertToString
        $currentDate: { lastUpdatedAt: true } // Alternative: use MongoDB to set current date
      }
    );
    // If $set was used for lastUpdatedAt before:
    // const poolUpdatePayload = { ...convertToString(...), lastUpdatedAt: new Date().toISOString() };
    // await cache.updateOnePromise(..., { $set: poolUpdatePayload });


    if (!poolUpdateSuccess) {
      logger.error(`[pool-remove-liquidity] Failed to update pool reserves for ${data.poolId}.`);
      return false;
    }

    const newLpBalance = userPosition.lpTokenBalance - data.lpTokenAmount;
    const userPositionUpdatePayload = {
        ...convertToString({ lpTokenBalance: newLpBalance }, ['lpTokenBalance']),
        lastUpdatedAt: new Date().toISOString()
    };
    const userPositionUpdateSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userLpPositionId },
        { $set: userPositionUpdatePayload }
    );

    if (!userPositionUpdateSuccess) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to update user LP position ${userLpPositionId}. Rolling back pool update.`);
        const rollbackPoolPayload = convertToString(
            {
                tokenA_reserve: pool.tokenA_reserve,
                tokenB_reserve: pool.tokenB_reserve,
                totalLpTokens: pool.totalLpTokens
            },
            ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']
        );
        await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, { $set: rollbackPoolPayload });
        return false;
    }

    const tokenAIdentifier = `${pool.tokenA_symbol}@${pool.tokenA_issuer}`;
    const tokenBIdentifier = `${pool.tokenB_symbol}@${pool.tokenB_issuer}`;

    if (!await adjustBalance(data.provider, tokenAIdentifier, tokenAAmountToReturn)) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${toString(tokenAAmountToReturn)} ${tokenAIdentifier} to ${data.provider}.`);
        const rollbackUserLpPayload = { ...convertToString({ lpTokenBalance: userPosition.lpTokenBalance }, ['lpTokenBalance']), lastUpdatedAt: new Date().toISOString() };
        await cache.updateOnePromise('userLiquidityPositions', { _id: userLpPositionId }, { $set: rollbackUserLpPayload });
        const rollbackPoolPayload = convertToString(pool, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);
        await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, { $set: rollbackPoolPayload });
        return false; 
    }
    if (!await adjustBalance(data.provider, tokenBIdentifier, tokenBAmountToReturn)) {
        logger.error(`[pool-remove-liquidity] CRITICAL: Failed to credit ${toString(tokenBAmountToReturn)} ${tokenBIdentifier} to ${data.provider}.`);
        await adjustBalance(data.provider, tokenAIdentifier, -tokenAAmountToReturn);
        const rollbackUserLpPayload = { ...convertToString({ lpTokenBalance: userPosition.lpTokenBalance }, ['lpTokenBalance']), lastUpdatedAt: new Date().toISOString() };
        await cache.updateOnePromise('userLiquidityPositions', { _id: userLpPositionId }, { $set: rollbackUserLpPayload });
        const rollbackPoolPayload = convertToString(pool, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);
        await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, { $set: rollbackPoolPayload });
        return false;
    }

    logger.debug(`[pool-remove-liquidity] ${data.provider} removed liquidity from pool ${data.poolId} by burning ${toString(data.lpTokenAmount)} LP tokens. Received ${toString(tokenAAmountToReturn)} ${pool.tokenA_symbol} and ${toString(tokenBAmountToReturn)} ${pool.tokenB_symbol}.`);

    const eventData = {
        poolId: data.poolId,
        provider: data.provider,
        lpTokensBurned: toString(data.lpTokenAmount),
        tokenA_symbol: pool.tokenA_symbol,
        tokenA_issuer: pool.tokenA_issuer,
        tokenA_amount_returned: toString(tokenAAmountToReturn),
        tokenB_symbol: pool.tokenB_symbol,
        tokenB_issuer: pool.tokenB_issuer,
        tokenB_amount_returned: toString(tokenBAmountToReturn)
    };
    await logTransactionEvent('poolRemoveLiquidity', sender, eventData, transactionId);

    return true;
  } catch (error) {
    logger.error(`[pool-remove-liquidity] Error processing remove liquidity for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
} 