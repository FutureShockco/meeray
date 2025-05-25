import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolAddLiquidityData, LiquidityPool, UserLiquidityPosition, PoolAddLiquidityDataDB, LiquidityPoolDB, UserLiquidityPositionDB } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';
import { convertToBigInt, convertToString, BigIntMath, toString as bigintToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS: Array<keyof PoolAddLiquidityData> = ['tokenA_amount', 'tokenB_amount'];

// Calculate LP tokens to mint based on provided liquidity
function calculateLpTokensToMint(tokenA_amount: bigint, tokenB_amount: bigint, pool: LiquidityPool): bigint {
  // Initial liquidity provision
  if (pool.totalLpTokens === BigInt(0)) {
    // For first liquidity provision, mint LP tokens equal to geometric mean of provided amounts
    return BigIntMath.sqrt(tokenA_amount * tokenB_amount);
  }

  // For subsequent liquidity provisions, mint proportional to existing reserves
  const ratioA = (tokenA_amount * pool.totalLpTokens) / pool.tokenA_reserve;
  const ratioB = (tokenB_amount * pool.totalLpTokens) / pool.tokenB_reserve;
  
  // Use the minimum ratio to ensure proportional liquidity provision
  return BigIntMath.min(ratioA, ratioB);
}

export async function validateTx(data: PoolAddLiquidityDataDB, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for validation
    const addLiquidityData = convertToBigInt<PoolAddLiquidityData>(data, NUMERIC_FIELDS);

    if (!addLiquidityData.poolId || !addLiquidityData.provider || !addLiquidityData.tokenA_amount || !addLiquidityData.tokenB_amount) {
      logger.warn('[pool-add-liquidity] Invalid data: Missing required fields.');
      return false;
    }

    if (sender !== addLiquidityData.provider) {
      logger.warn('[pool-add-liquidity] Sender must be the liquidity provider.');
      return false;
    }

    const poolDB = await cache.findOnePromise('liquidityPools', { _id: addLiquidityData.poolId }) as LiquidityPoolDB | null;
    if (!poolDB) {
      logger.warn(`[pool-add-liquidity] Pool ${addLiquidityData.poolId} not found.`);
      return false;
    }

    // Convert pool amounts to BigInt for calculations
    const pool = convertToBigInt<LiquidityPool>(poolDB, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);

    // For initial liquidity provision, both token amounts must be positive
    if (pool.totalLpTokens === BigInt(0)) {
      if (addLiquidityData.tokenA_amount <= BigInt(0) || addLiquidityData.tokenB_amount <= BigInt(0)) {
        logger.warn('[pool-add-liquidity] Initial liquidity provision requires positive amounts for both tokens.');
        return false;
      }
    } else {
      // For subsequent provisions, check if amounts maintain the pool ratio within tolerance
      const expectedTokenBAmount = (addLiquidityData.tokenA_amount * pool.tokenB_reserve) / pool.tokenA_reserve;
      const tolerance = BigInt(100); // 1% tolerance as basis points (100 = 1%)
      const difference = BigIntMath.abs(addLiquidityData.tokenB_amount - expectedTokenBAmount);
      const maxDifference = (expectedTokenBAmount * tolerance) / BigInt(10000);

      if (difference > maxDifference) {
        logger.warn(`[pool-add-liquidity] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount}, Got: ${addLiquidityData.tokenB_amount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${addLiquidityData.tokenA_amount}`);
        return false;
      }
    }

    const providerAccount = await getAccount(addLiquidityData.provider);
    if (!providerAccount) {
      logger.warn(`[pool-add-liquidity] Provider account ${addLiquidityData.provider} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error validating add liquidity data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(transaction: { data: PoolAddLiquidityDataDB, sender: string, _id: string }): Promise<boolean> {
  const { data: dataDb, sender, _id: transactionId } = transaction;
  try {
    // Convert string amounts to BigInt for processing
    const addLiquidityData = convertToBigInt<PoolAddLiquidityData>(dataDb, NUMERIC_FIELDS);

    const poolDB = await cache.findOnePromise('liquidityPools', { _id: addLiquidityData.poolId }) as LiquidityPoolDB | null;
    if (!poolDB) {
      logger.error(`[pool-add-liquidity] CRITICAL: Pool ${addLiquidityData.poolId} not found during processing.`);
      return false;
    }

    // Convert pool amounts to BigInt for calculations
    const pool = convertToBigInt<LiquidityPool>(poolDB, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);

    // Calculate LP tokens to mint
    const lpTokensToMint = calculateLpTokensToMint(addLiquidityData.tokenA_amount, addLiquidityData.tokenB_amount, pool);
    if (lpTokensToMint <= BigInt(0)) {
      logger.error('[pool-add-liquidity] CRITICAL: LP token calculation resulted in zero or negative amount.');
      return false;
    }

    // Update pool reserves and total LP tokens with proper padding
    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: addLiquidityData.poolId },
      {
        $set: {
          ...convertToString(
            {
              tokenA_reserve: pool.tokenA_reserve + addLiquidityData.tokenA_amount,
              tokenB_reserve: pool.tokenB_reserve + addLiquidityData.tokenB_amount,
              totalLpTokens: pool.totalLpTokens + lpTokensToMint
            },
            ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']
          ),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    );

    if (!poolUpdateSuccess) {
      logger.error(`[pool-add-liquidity] Failed to update pool ${addLiquidityData.poolId}. Add liquidity aborted.`);
      return false;
    }

    // Update or create user liquidity position with proper padding
    const userPositionId = `${addLiquidityData.provider}-${addLiquidityData.poolId}`;
    const existingUserPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userPositionId }) as UserLiquidityPositionDB | null;
    const existingUserPos = existingUserPosDB ? convertToBigInt<UserLiquidityPosition>(existingUserPosDB, ['lpTokenBalance']) : null;

    let userPosUpdateSuccess = false;

    if (existingUserPos) {
      userPosUpdateSuccess = await cache.updateOnePromise(
        'userLiquidityPositions',
        { _id: userPositionId },
        {
          $set: {
            ...convertToString(
              { lpTokenBalance: existingUserPos.lpTokenBalance + lpTokensToMint },
              ['lpTokenBalance']
            ),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      const newUserPosition: UserLiquidityPosition = {
        _id: userPositionId,
        provider: addLiquidityData.provider,
        poolId: addLiquidityData.poolId,
        lpTokenBalance: lpTokensToMint,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      };

      // Convert BigInt fields to strings for database storage with proper padding
      const newUserPositionDB = convertToString(newUserPosition, ['lpTokenBalance']);

      userPosUpdateSuccess = await new Promise<boolean>((resolve) => {
        cache.insertOne('userLiquidityPositions', newUserPositionDB, (err, success) => {
          if (err || !success) {
            logger.error(`[pool-add-liquidity] Failed to insert new user position ${userPositionId}: ${err || 'insert not successful'}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    if (!userPosUpdateSuccess) {
      logger.error(`[pool-add-liquidity] CRITICAL: Failed to update user position. Rolling back pool update.`);
      // Rollback pool update
      await cache.updateOnePromise(
        'liquidityPools',
        { _id: addLiquidityData.poolId },
        {
          $set: convertToString(
            {
              tokenA_reserve: pool.tokenA_reserve,
              tokenB_reserve: pool.tokenB_reserve,
              totalLpTokens: pool.totalLpTokens
            },
            ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']
          )
        }
      );
      return false;
    }

    logger.debug(`[pool-add-liquidity] Provider ${addLiquidityData.provider} added liquidity to pool ${addLiquidityData.poolId}. Token A: ${bigintToString(addLiquidityData.tokenA_amount)}, Token B: ${bigintToString(addLiquidityData.tokenB_amount)}, LP tokens minted: ${bigintToString(lpTokensToMint)}`);

    // Log event using the new centralized logger
    const eventData = {
        poolId: addLiquidityData.poolId,
        provider: addLiquidityData.provider,
        tokenA_amount: bigintToString(addLiquidityData.tokenA_amount),
        tokenB_amount: bigintToString(addLiquidityData.tokenB_amount),
        lpTokensMinted: bigintToString(lpTokensToMint)
    };
    await logTransactionEvent('poolAddLiquidity', sender, eventData, transactionId);

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${dataDb.poolId} by ${sender}: ${error}`);
    return false;
  }
} 