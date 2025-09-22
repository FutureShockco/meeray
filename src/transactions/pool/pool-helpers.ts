import logger from '../../logger.js';
import cache from '../../cache.js';
import { LiquidityPoolData, UserLiquidityPositionData } from './pool-interfaces.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { adjustUserBalance } from '../../utils/account.js';

/**
 * Creates a liquidity pool in the database
 */
export async function createLiquidityPool(
  poolId: string,
  tokenA_symbol: string,
  tokenB_symbol: string
): Promise<boolean> {
  try {
    const poolDocument: LiquidityPoolData = {
      _id: poolId,
      tokenA_symbol,
      tokenA_reserve: toDbString(BigInt(0)),
      tokenB_symbol,
      tokenB_reserve: toDbString(BigInt(0)),
      totalLpTokens: toDbString(BigInt(0)),
      createdAt: new Date().toISOString(),
      status: 'ACTIVE'
    };

    const createSuccess = await cache.insertOnePromise('liquidityPools', poolDocument);
    if (!createSuccess) {
      logger.error(`[pool-helpers] Failed to create liquidity pool ${poolId}`);
      return false;
    }

    logger.debug(`[pool-helpers] Liquidity Pool ${poolId} (${tokenA_symbol}-${tokenB_symbol}) created successfully`);
    return true;
  } catch (error) {
    logger.error(`[pool-helpers] Error creating liquidity pool ${poolId}: ${error}`);
    return false;
  }
}

/**
 * Creates an LP token for the liquidity pool
 */
export async function createLpToken(
  tokenA_symbol: string,
  tokenB_symbol: string,
  poolId: string
): Promise<boolean> {
  try {
    const lpTokenSymbol = getLpTokenSymbol(tokenA_symbol, tokenB_symbol);
    
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (existingLpToken) {
      logger.debug(`[pool-helpers] LP token ${lpTokenSymbol} already exists`);
      return true;
    }

    const lpToken = {
      _id: lpTokenSymbol,
      symbol: lpTokenSymbol,
      name: `LP Token for ${tokenA_symbol}-${tokenB_symbol}`,
      issuer: 'null',
      precision: 18,
      maxSupply: toDbString(BigInt(1000000000000000000)), // Large max supply
      currentSupply: toDbString(BigInt(0)),
      mintable: false,
      burnable: false,
      description: `Liquidity provider token for pool ${poolId}`,
      createdAt: new Date().toISOString()
    };

    const lpTokenSuccess = await cache.insertOnePromise('tokens', lpToken);
    if (!lpTokenSuccess) {
      logger.error(`[pool-helpers] Failed to create LP token ${lpTokenSymbol}`);
      return false;
    }

    logger.info(`[pool-helpers] Created LP token ${lpTokenSymbol} for pool ${poolId}`);
    return true;
  } catch (error) {
    logger.error(`[pool-helpers] Error creating LP token for pool ${poolId}: ${error}`);
    return false;
  }
}

/**
 * Creates a trading pair for the liquidity pool
 */
export async function createTradingPair(
  poolId: string,
  tokenA_symbol: string,
  tokenB_symbol: string,
  sender: string,
  transactionId: string
): Promise<boolean> {
  try {
    const maxTradeAmount = BigInt(1000000000000000000000000000000); // 1,000,000,000

    const tradingPairDocument = {
      _id: poolId,
      baseAssetSymbol: tokenA_symbol,
      quoteAssetSymbol: tokenB_symbol,
      tickSize: toDbString(1),
      lotSize: toDbString(1),
      minNotional: toDbString(1),
      status: 'TRADING',
      minTradeAmount: toDbString(1),
      maxTradeAmount: toDbString(maxTradeAmount),
      createdAt: new Date().toISOString()
    };

    const pairInsertSuccess = await cache.insertOnePromise('tradingPairs', tradingPairDocument);
    if (!pairInsertSuccess) {
      logger.warn(`[pool-helpers] Failed to create trading pair ${poolId}`);
      return false;
    }

    logger.info(`[pool-helpers] Created trading pair ${poolId} for pool`);

    // Log trading pair creation event
    await logEvent('market', 'pair_created', sender, {
      pairId: poolId,
      baseAssetSymbol: tokenA_symbol,
      quoteAssetSymbol: tokenB_symbol,
      tickSize: toDbString(1),
      lotSize: toDbString(1),
      minNotional: toDbString(1),
      minTradeAmount: toDbString(1),
      maxTradeAmount: toDbString(maxTradeAmount),
      initialStatus: 'TRADING',
      createdAt: new Date().toISOString(),
      autoCreated: true,
      poolId: poolId
    }, transactionId);

    return true;
  } catch (error) {
    logger.error(`[pool-helpers] Error creating trading pair for pool ${poolId}: ${error}`);
    return false;
  }
}

/**
 * Debits tokens from user account for liquidity addition
 */
export async function debitLiquidityTokens(
  user: string,
  tokenASymbol: string,
  tokenBSymbol: string,
  tokenAAmount: string | bigint,
  tokenBAmount: string | bigint
): Promise<boolean> {
  const debitASuccess = await adjustUserBalance(user, tokenASymbol, -toBigInt(tokenAAmount));
  const debitBSuccess = await adjustUserBalance(user, tokenBSymbol, -toBigInt(tokenBAmount));

  if (!debitASuccess || !debitBSuccess) {
    logger.error(`[pool-helpers] Failed to debit tokens from ${user}.`);
    return false;
  }

  return true;
}

/**
 * Updates pool reserves and total LP tokens
 */
export async function updatePoolReserves(
  poolId: string,
  pool: LiquidityPoolData,
  tokenAAmount: string | bigint,
  tokenBAmount: string | bigint,
  lpTokensToMint: bigint
): Promise<boolean> {
  const MINIMUM_LIQUIDITY = BigInt(1);
  const isInitialLiquidity = toBigInt(pool.totalLpTokens) === BigInt(0);
  
  // For initial liquidity, add both minted tokens + burned minimum liquidity to total
  const totalLpTokensToAdd = isInitialLiquidity ? lpTokensToMint + MINIMUM_LIQUIDITY : lpTokensToMint;
  
  const poolUpdateSuccess = await cache.updateOnePromise(
    'liquidityPools',
    { _id: poolId },
    {
      $set: {
        tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) + toBigInt(tokenAAmount)),
        tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) + toBigInt(tokenBAmount)),
        totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) + totalLpTokensToAdd),
        feeGrowthGlobalA: toDbString(pool.feeGrowthGlobalA || BigInt(0)),
        feeGrowthGlobalB: toDbString(pool.feeGrowthGlobalB || BigInt(0)),
        lastUpdatedAt: new Date().toISOString()
      }
    }
  );

  if (!poolUpdateSuccess) {
    logger.error(`[pool-helpers] Failed to update pool ${poolId}. Add liquidity aborted.`);
    return false;
  }

  return true;
}

/**
 * Updates or creates user liquidity position with fee checkpoints
 */
export async function updateUserLiquidityPosition(
  user: string,
  poolId: string,
  lpTokensToMint: bigint,
  pool: LiquidityPoolData
): Promise<boolean> {
  const userPositionId = `${user}-${poolId}`;
  const existingUserPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userPositionId }) as UserLiquidityPositionData | null;
  
  const existingUserPos = existingUserPosDB ? {
    ...existingUserPosDB,
    lpTokenBalance: toBigInt(existingUserPosDB.lpTokenBalance),
    feeGrowthEntryA: toBigInt(existingUserPosDB.feeGrowthEntryA || '0'),
    feeGrowthEntryB: toBigInt(existingUserPosDB.feeGrowthEntryB || '0'),
    unclaimedFeesA: toBigInt(existingUserPosDB.unclaimedFeesA || '0'),
    unclaimedFeesB: toBigInt(existingUserPosDB.unclaimedFeesB || '0'),
  } : null;

  let userPosUpdateSuccess = false;

  if (existingUserPos) {
    // Calculate unclaimed fees before updating position
    const deltaA = toBigInt(pool.feeGrowthGlobalA || '0') - toBigInt(existingUserPos.feeGrowthEntryA || '0');
    const deltaB = toBigInt(pool.feeGrowthGlobalB || '0') - toBigInt(existingUserPos.feeGrowthEntryB || '0');
    const newUnclaimedFeesA = (existingUserPos.unclaimedFeesA || BigInt(0)) + (deltaA * existingUserPos.lpTokenBalance) / BigInt(1e18);
    const newUnclaimedFeesB = (existingUserPos.unclaimedFeesB || BigInt(0)) + (deltaB * existingUserPos.lpTokenBalance) / BigInt(1e18);
    
    userPosUpdateSuccess = await cache.updateOnePromise(
      'userLiquidityPositions',
      { _id: userPositionId },
      {
        $set: {
          lpTokenBalance: toDbString(existingUserPos.lpTokenBalance + lpTokensToMint),
          feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || 0),
          feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || 0),
          unclaimedFeesA: toDbString(newUnclaimedFeesA),
          unclaimedFeesB: toDbString(newUnclaimedFeesB),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    );
  } else {
    const newUserPosition: UserLiquidityPositionData = {
      _id: userPositionId,
      user,
      poolId,
      lpTokenBalance: toDbString(lpTokensToMint),
      feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || 0),
      feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || 0),
      unclaimedFeesA: toDbString(0),
      unclaimedFeesB: toDbString(0),
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    };
    
    userPosUpdateSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('userLiquidityPositions', newUserPosition, (err, success) => {
        if (err || !success) {
          logger.error(`[pool-helpers] Failed to insert new user position ${userPositionId}: ${err || 'insert not successful'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  if (!userPosUpdateSuccess) {
    logger.error(`[pool-helpers] CRITICAL: Failed to update user position.`);
    return false;
  }

  return true;
}

/**
 * Credits LP tokens to the user's account
 */
export async function creditLpTokens(
  user: string,
  tokenASymbol: string,
  tokenBSymbol: string,
  lpTokensToMint: bigint,
  poolId: string
): Promise<boolean> {
  const lpTokenSymbol = getLpTokenSymbol(tokenASymbol, tokenBSymbol);
  const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
  
  if (!existingLpToken) {
    logger.error(`[pool-helpers] LP token ${lpTokenSymbol} does not exist for pool ${poolId}. This should be created during pool creation.`);
    return false;
  }

  const creditLPSuccess = await adjustUserBalance(user, lpTokenSymbol, lpTokensToMint);
  if (!creditLPSuccess) {
    logger.error(`[pool-helpers] Failed to credit LP tokens (${lpTokenSymbol}) to ${user}.`);
    return false;
  }

  return true;
}
