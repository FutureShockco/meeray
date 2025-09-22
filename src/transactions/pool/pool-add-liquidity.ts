import logger from '../../logger.js';
import cache from '../../cache.js';
import { PoolAddLiquidityData, LiquidityPoolData, UserLiquidityPositionData } from './pool-interfaces.js';
import { adjustBalance, getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { calculateLpTokensToMint } from '../../utils/pool.js';

export async function validateTx(data: PoolAddLiquidityData, sender: string): Promise<boolean> {
  try {

    if (!data.poolId || !data.provider || !data.tokenA_amount || !data.tokenB_amount) {
      logger.warn('[pool-add-liquidity] Invalid data: Missing required fields.');
      return false;
    }

    if (sender !== data.provider) {
      logger.warn('[pool-add-liquidity] Sender must be the liquidity provider.');
      return false;
    }

    const poolDB = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolData | null;
    if (!poolDB) {
      logger.warn(`[pool-add-liquidity] Pool ${data.poolId} not found.`);
      return false;
    }

    // Convert pool amounts to BigInt for calculations
    const pool = poolDB;

    // Check provider's balance for both tokens
    const providerAccount = await getAccount(data.provider);
    if (!providerAccount) {
      logger.warn(`[pool-add-liquidity] Provider account ${data.provider} not found.`);
      return false;
    }

    // Check if provider has sufficient balance for both tokens
    const tokenABalance = toBigInt(providerAccount.balances[pool.tokenA_symbol] || '0');
    const tokenBBalance = toBigInt(providerAccount.balances[pool.tokenB_symbol] || '0');

    if (tokenABalance < toBigInt(data.tokenA_amount)) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenA_symbol}. Required: ${data.tokenA_amount}, Available: ${tokenABalance}`);
      return false;
    }

    if (tokenBBalance < toBigInt(data.tokenB_amount)) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenB_symbol}. Required: ${data.tokenB_amount}, Available: ${tokenBBalance}`);
      return false;
    }

    // For initial liquidity provision, both token amounts must be positive
    if (toBigInt(pool.totalLpTokens) === BigInt(0)) {
      if (toBigInt(data.tokenA_amount) <= BigInt(0) || toBigInt(data.tokenB_amount) <= BigInt(0)) {
        logger.warn('[pool-add-liquidity] Initial liquidity provision requires positive amounts for both tokens.');
        return false;
      }
    } else {
      // For subsequent provisions, check if amounts maintain the pool ratio within tolerance
      const expectedTokenBAmount = (toBigInt(data.tokenA_amount) * toBigInt(pool.tokenB_reserve)) / toBigInt(pool.tokenA_reserve);
      const tolerance = BigInt(100); // 1% tolerance as basis points (100 = 1%)
      const actualB = toBigInt(data.tokenB_amount);
      const difference = actualB > expectedTokenBAmount ? actualB - expectedTokenBAmount : expectedTokenBAmount - actualB;
      const maxDifference = (expectedTokenBAmount * tolerance) / BigInt(10000);

      if (difference > maxDifference) {
        logger.warn(`[pool-add-liquidity] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount}, Got: ${data.tokenB_amount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${data.tokenA_amount}`);
        return false;
      }
    }

    // Validate that the LP token exists for this pool
    const lpTokenSymbol = getLpTokenSymbol(pool.tokenA_symbol, pool.tokenB_symbol);
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (!existingLpToken) {
      logger.warn(`[pool-add-liquidity] LP token ${lpTokenSymbol} does not exist for pool ${data.poolId}. This suggests the pool was created before the LP token creation was fixed. Please contact support or recreate the pool.`);
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

    // Ensure fee accounting fields are present and initialized as bigint
    let feeGrowthGlobalA = toBigInt(poolDB.feeGrowthGlobalA || '0');
    let feeGrowthGlobalB = toBigInt(poolDB.feeGrowthGlobalB || '0');
    const pool = {
      ...poolDB,
      feeGrowthGlobalA,
      feeGrowthGlobalB
    };

    // Debit tokens from the provider's account
    const debitASuccess = await adjustBalance(data.provider, pool.tokenA_symbol, -toBigInt(data.tokenA_amount));
    const debitBSuccess = await adjustBalance(data.provider, pool.tokenB_symbol, -toBigInt(data.tokenB_amount));

    if (!debitASuccess || !debitBSuccess) {
      logger.error(`[pool-add-liquidity] Failed to debit tokens from ${data.provider}.`);
      return false;
    }

    const lpTokensToMint = calculateLpTokensToMint(toBigInt(data.tokenA_amount), toBigInt(data.tokenB_amount), pool);
    if (lpTokensToMint <= BigInt(0)) {
      logger.error('[pool-add-liquidity] CRITICAL: LP token calculation resulted in zero or negative amount.');
      return false;
    }

    // Update pool reserves and total LP tokens
    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: data.poolId },
      {
        $set: {
          tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) + toBigInt(data.tokenA_amount)),
          tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) + toBigInt(data.tokenB_amount)),
          totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) + lpTokensToMint),
          feeGrowthGlobalA: toDbString(pool.feeGrowthGlobalA),
          feeGrowthGlobalB: toDbString(pool.feeGrowthGlobalB),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    )

    if (!poolUpdateSuccess) {
      logger.error(`[pool-add-liquidity] Failed to update pool ${data.poolId}. Add liquidity aborted.`);
      return false;
    }

    // Update or create user liquidity position with fee checkpoints
    const userPositionId = `${data.provider}-${data.poolId}`;
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
    let newFeeGrowthEntryA = pool.feeGrowthGlobalA || BigInt(0);
    let newFeeGrowthEntryB = pool.feeGrowthGlobalB || BigInt(0);
    let newUnclaimedFeesA = BigInt(0);
    let newUnclaimedFeesB = BigInt(0);

    if (existingUserPos) {
      // Calculate unclaimed fees before updating position
      const deltaA = (pool.feeGrowthGlobalA || BigInt(0)) - (existingUserPos.feeGrowthEntryA || BigInt(0));
      const deltaB = (pool.feeGrowthGlobalB || BigInt(0)) - (existingUserPos.feeGrowthEntryB || BigInt(0));
      newUnclaimedFeesA = (existingUserPos.unclaimedFeesA || BigInt(0)) + (deltaA * existingUserPos.lpTokenBalance) / BigInt(1e18);
      newUnclaimedFeesB = (existingUserPos.unclaimedFeesB || BigInt(0)) + (deltaB * existingUserPos.lpTokenBalance) / BigInt(1e18);
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
        provider: data.provider,
        poolId: data.poolId,
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
            logger.error(`[pool-add-liquidity] Failed to insert new user position ${userPositionId}: ${err || 'insert not successful'}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    if (!userPosUpdateSuccess) {
      logger.error(`[pool-add-liquidity] CRITICAL: Failed to update user position.`);
      return false;
    }

    // After updating userLiquidityPositions, ensure LP token exists before crediting
    const lpTokenSymbol = getLpTokenSymbol(pool.tokenA_symbol, pool.tokenB_symbol);
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (!existingLpToken) {
      logger.error(`[pool-add-liquidity] LP token ${lpTokenSymbol} does not exist for pool ${data.poolId}. This should be created during pool creation.`);
      return false;
    }

    // After updating userLiquidityPositions, credit LP tokens to user account
    const creditLPSuccess = await adjustBalance(data.provider, lpTokenSymbol, lpTokensToMint);
    if (!creditLPSuccess) {
      logger.error(`[pool-add-liquidity] Failed to credit LP tokens (${lpTokenSymbol}) to ${data.provider}.`);
      return false;
    }

    logger.debug(`[pool-add-liquidity] Provider ${data.provider} added liquidity to pool ${data.poolId}. Token A: ${data.tokenA_amount}, Token B: ${data.tokenB_amount}, LP tokens minted: ${lpTokensToMint}`);

    // Log event
    await logEvent('defi', 'liquidity_added', data.provider, {
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