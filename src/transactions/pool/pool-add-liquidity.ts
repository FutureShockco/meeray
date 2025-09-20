import logger from '../../logger.js';
import cache from '../../cache.js';
import { PoolAddLiquidityData, LiquidityPoolData, UserLiquidityPositionData } from './pool-interfaces.js';
import { adjustBalance, getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getLpTokenSymbol } from '../../utils/token.js';

// Integer square root function for BigInt
function sqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error('Cannot calculate square root of negative number');
  }
  if (value < 2n) {
    return value;
  }

  // Binary search for square root
  let x = value;
  let y = (x + 1n) / 2n;

  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }

  return x;
}

// Calculate LP tokens to mint based on provided liquidity
// For initial liquidity: uses geometric mean (sqrt of product) for fair distribution
// For subsequent liquidity: uses proportional minting based on existing reserves
function calculateLpTokensToMint(tokenA_amount: bigint, tokenB_amount: bigint, pool: LiquidityPoolData): bigint {
  // Initial liquidity provision
  if (toBigInt(pool.totalLpTokens) === BigInt(0)) {
    // For first liquidity provision, mint LP tokens equal to geometric mean of provided amounts
    // Use geometric mean for fair initial distribution
    const product = tokenA_amount * tokenB_amount;
    return sqrt(product);
  }

  // For subsequent liquidity provisions, mint proportional to existing reserves
  const poolTotalLpTokens = toBigInt(pool.totalLpTokens);
  const poolTokenAReserve = toBigInt(pool.tokenA_reserve);
  const poolTokenBReserve = toBigInt(pool.tokenB_reserve);

  const ratioA = (tokenA_amount * poolTotalLpTokens) / poolTokenAReserve;
  const ratioB = (tokenB_amount * poolTotalLpTokens) / poolTokenBReserve;

  // Use the minimum ratio to ensure proportional liquidity provision
  return ratioA < ratioB ? ratioA : ratioB;
}

export async function validateTx(data: PoolAddLiquidityData, sender: string): Promise<boolean> {
  try {
    // Convert string amounts to BigInt for validation
    const addLiquidityData = data;

    if (!addLiquidityData.poolId || !addLiquidityData.provider || !addLiquidityData.tokenA_amount || !addLiquidityData.tokenB_amount) {
      logger.warn('[pool-add-liquidity] Invalid data: Missing required fields.');
      return false;
    }

    if (sender !== addLiquidityData.provider) {
      logger.warn('[pool-add-liquidity] Sender must be the liquidity provider.');
      return false;
    }

    const poolDB = await cache.findOnePromise('liquidityPools', { _id: addLiquidityData.poolId }) as LiquidityPoolData | null;
    if (!poolDB) {
      logger.warn(`[pool-add-liquidity] Pool ${addLiquidityData.poolId} not found.`);
      return false;
    }

    // Convert pool amounts to BigInt for calculations
    const pool = poolDB;

    // Check provider's balance for both tokens
    const providerAccount = await getAccount(addLiquidityData.provider);
    if (!providerAccount) {
      logger.warn(`[pool-add-liquidity] Provider account ${addLiquidityData.provider} not found.`);
      return false;
    }

    // Check if provider has sufficient balance for both tokens
    const tokenABalance = toBigInt(providerAccount.balances[pool.tokenA_symbol] || '0');
    const tokenBBalance = toBigInt(providerAccount.balances[pool.tokenB_symbol] || '0');

    if (tokenABalance < toBigInt(addLiquidityData.tokenA_amount)) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenA_symbol}. Required: ${addLiquidityData.tokenA_amount}, Available: ${tokenABalance}`);
      return false;
    }

    if (tokenBBalance < toBigInt(addLiquidityData.tokenB_amount)) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenB_symbol}. Required: ${addLiquidityData.tokenB_amount}, Available: ${tokenBBalance}`);
      return false;
    }

    // For initial liquidity provision, both token amounts must be positive
    if (toBigInt(pool.totalLpTokens) === BigInt(0)) {
      if (toBigInt(addLiquidityData.tokenA_amount) <= BigInt(0) || toBigInt(addLiquidityData.tokenB_amount) <= BigInt(0)) {
        logger.warn('[pool-add-liquidity] Initial liquidity provision requires positive amounts for both tokens.');
        return false;
      }
    } else {
      // For subsequent provisions, check if amounts maintain the pool ratio within tolerance
      const expectedTokenBAmount = (toBigInt(addLiquidityData.tokenA_amount) * toBigInt(pool.tokenB_reserve)) / toBigInt(pool.tokenA_reserve);
      const tolerance = BigInt(100); // 1% tolerance as basis points (100 = 1%)
      const actualB = toBigInt(addLiquidityData.tokenB_amount);
      const difference = actualB > expectedTokenBAmount ? actualB - expectedTokenBAmount : expectedTokenBAmount - actualB;
      const maxDifference = (expectedTokenBAmount * tolerance) / BigInt(10000);

      if (difference > maxDifference) {
        logger.warn(`[pool-add-liquidity] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount}, Got: ${addLiquidityData.tokenB_amount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${addLiquidityData.tokenA_amount}`);
        return false;
      }
    }

    // Validate that the LP token exists for this pool
    const lpTokenSymbol = getLpTokenSymbol(pool.tokenA_symbol, pool.tokenB_symbol);
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (!existingLpToken) {
      logger.warn(`[pool-add-liquidity] LP token ${lpTokenSymbol} does not exist for pool ${addLiquidityData.poolId}. This suggests the pool was created before the LP token creation was fixed. Please contact support or recreate the pool.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error validating add liquidity data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: PoolAddLiquidityData, sender: string, id: string): Promise<boolean> {
  try {
    const addLiquidityData = data;

    const poolDB = await cache.findOnePromise('liquidityPools', { _id: addLiquidityData.poolId }) as LiquidityPoolData; // validateTx guarantees existence

    // Ensure fee accounting fields are present and initialized as bigint
    let feeGrowthGlobalA = toBigInt(poolDB.feeGrowthGlobalA || '0');
    let feeGrowthGlobalB = toBigInt(poolDB.feeGrowthGlobalB || '0');
    const pool = {
      ...poolDB,
      feeGrowthGlobalA,
      feeGrowthGlobalB
    };

    // Debit tokens from the provider's account
    const debitASuccess = await adjustBalance(addLiquidityData.provider, pool.tokenA_symbol, -toBigInt(addLiquidityData.tokenA_amount));
    const debitBSuccess = await adjustBalance(addLiquidityData.provider, pool.tokenB_symbol, -toBigInt(addLiquidityData.tokenB_amount));

    if (!debitASuccess || !debitBSuccess) {
      logger.error(`[pool-add-liquidity] Failed to debit tokens from ${addLiquidityData.provider}.`);
      return false;
    }

    const lpTokensToMint = calculateLpTokensToMint(toBigInt(addLiquidityData.tokenA_amount), toBigInt(addLiquidityData.tokenB_amount), pool);
    if (lpTokensToMint <= BigInt(0)) {
      logger.error('[pool-add-liquidity] CRITICAL: LP token calculation resulted in zero or negative amount.');
      return false;
    }

    // Update pool reserves and total LP tokens
    const poolUpdateSuccess = await cache.updateOnePromise(
      'liquidityPools',
      { _id: addLiquidityData.poolId },
      {
        $set: {
          tokenA_reserve: toDbString(toBigInt(pool.tokenA_reserve) + toBigInt(addLiquidityData.tokenA_amount)),
          tokenB_reserve: toDbString(toBigInt(pool.tokenB_reserve) + toBigInt(addLiquidityData.tokenB_amount)),
          totalLpTokens: toDbString(toBigInt(pool.totalLpTokens) + lpTokensToMint),
          feeGrowthGlobalA: toDbString(pool.feeGrowthGlobalA),
          feeGrowthGlobalB: toDbString(pool.feeGrowthGlobalB),
          lastUpdatedAt: new Date().toISOString()
        }
      }
    )

    if (!poolUpdateSuccess) {
      logger.error(`[pool-add-liquidity] Failed to update pool ${addLiquidityData.poolId}. Add liquidity aborted.`);
      return false;
    }

    // Update or create user liquidity position with fee checkpoints
    const userPositionId = `${addLiquidityData.provider}-${addLiquidityData.poolId}`;
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
            feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || BigInt(0)),
            feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || BigInt(0)),
            unclaimedFeesA: toDbString(newUnclaimedFeesA),
            unclaimedFeesB: toDbString(newUnclaimedFeesB),
            lastUpdatedAt: new Date().toISOString()
          }
        }
      );
    } else {
      const newUserPosition: UserLiquidityPositionData = {
        _id: userPositionId,
        provider: addLiquidityData.provider,
        poolId: addLiquidityData.poolId,
        lpTokenBalance: toDbString(lpTokensToMint),
        feeGrowthEntryA: toDbString(pool.feeGrowthGlobalA || BigInt(0)),
        feeGrowthEntryB: toDbString(pool.feeGrowthGlobalB || BigInt(0)),
        unclaimedFeesA: toDbString(BigInt(0)),
        unclaimedFeesB: toDbString(BigInt(0)),
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
      logger.error(`[pool-add-liquidity] LP token ${lpTokenSymbol} does not exist for pool ${addLiquidityData.poolId}. This should be created during pool creation.`);
      return false;
    }

    // After updating userLiquidityPositions, credit LP tokens to user account
    const creditLPSuccess = await adjustBalance(addLiquidityData.provider, lpTokenSymbol, lpTokensToMint);
    if (!creditLPSuccess) {
      logger.error(`[pool-add-liquidity] Failed to credit LP tokens (${lpTokenSymbol}) to ${addLiquidityData.provider}.`);
      return false;
    }

    logger.debug(`[pool-add-liquidity] Provider ${addLiquidityData.provider} added liquidity to pool ${addLiquidityData.poolId}. Token A: ${addLiquidityData.tokenA_amount}, Token B: ${addLiquidityData.tokenB_amount}, LP tokens minted: ${lpTokensToMint}`);

    // Log event
    await logEvent('defi', 'liquidity_added', addLiquidityData.provider, {
      poolId: addLiquidityData.poolId,
      tokenAAmount: toDbString(BigInt(addLiquidityData.tokenA_amount)),
      tokenBAmount: toDbString(BigInt(addLiquidityData.tokenB_amount)),
      lpTokensMinted: toDbString(lpTokensToMint)
    }, id);

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}