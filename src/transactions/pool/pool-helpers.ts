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
      tokenA_reserve: toDbString(0),
      tokenB_symbol,
      tokenB_reserve: toDbString(0),
      totalLpTokens: toDbString(0),
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
      name: `LP Token for ${tokenA_symbol}_${tokenB_symbol}`,
      issuer: 'null',
      precision: 18,
      maxSupply: toDbString(1000000000000000000), // Large max supply
      currentSupply: toDbString(0),
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
  const isInitialLiquidity = toBigInt(pool.totalLpTokens) === BigInt(0);

  // For initial liquidity, calculate the actual minimum that was burned
  let minimumLiquidityBurned = BigInt(0);
  if (isInitialLiquidity) {
    // Re-calculate what minimum was actually burned (adaptive)
    const BASE_MINIMUM = BigInt(1000);
    const totalLiquidity = lpTokensToMint + BASE_MINIMUM; // Approximate total before burn
    const ADAPTIVE_MINIMUM = totalLiquidity / BigInt(1000);
    minimumLiquidityBurned = ADAPTIVE_MINIMUM > BigInt(0) && ADAPTIVE_MINIMUM < BASE_MINIMUM
      ? ADAPTIVE_MINIMUM
      : BASE_MINIMUM;
  }

  const totalLpTokensToAdd = isInitialLiquidity ? lpTokensToMint + minimumLiquidityBurned : lpTokensToMint;

  const poolUpdateSuccess = await cache.updateOnePromise(
    'liquidityPools',
    { _id: poolId },
    {
      $set: {
        tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) + toBigInt(tokenAAmount)),
        tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) + toBigInt(tokenBAmount)),
        totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) + totalLpTokensToAdd),
        feeGrowthGlobalA: toDbString(pool.feeGrowthGlobalA || '0'),
        feeGrowthGlobalB: toDbString(pool.feeGrowthGlobalB || '0'),
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


// Helper function to find trading pair ID regardless of token order
export async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
  // Try multiple patterns: hyphen and underscore, both orders
  const patterns = [
    `${tokenA}-${tokenB}`,   // tokenA-tokenB (hyphen)
    `${tokenB}-${tokenA}`,   // tokenB-tokenA (hyphen)
    `${tokenA}_${tokenB}`,   // tokenA_tokenB (underscore)
    `${tokenB}_${tokenA}`    // tokenB_tokenA (underscore)
  ];

  for (const pairId of patterns) {
    const tradingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (tradingPair) {
      return pairId;
    }
  }

  return null;
}

// Helper function to record pool swaps as market trades
export async function recordPoolSwapTrade(params: {
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
          logger.error(`[pool-swap] Trade record that failed:`, JSON.stringify(tradeRecord, null, 2));
          reject(err);
        } else {
          logger.debug(`[pool-swap] Successfully recorded trade ${tradeRecord._id}`);
          resolve();
        }
      });
    });

    logger.debug(`[pool-swap] Recorded trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`);
  } catch (error) {
    logger.error(`[pool-swap] Error recording trade: ${error}`);
  }
}
