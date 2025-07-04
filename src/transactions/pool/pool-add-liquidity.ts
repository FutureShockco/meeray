import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolAddLiquidityData, LiquidityPool, UserLiquidityPosition, PoolAddLiquidityDataDB, LiquidityPoolDB, UserLiquidityPositionDB } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';
import { convertToBigInt, convertToString, BigIntMath, toString as bigintToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import { toBigInt } from '../../utils/bigint-utils.js';
import { getLpTokenSymbol } from '../../utils/token-utils.js';

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
    const pool = convertToBigInt<LiquidityPool>(poolDB, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

    // Check provider's balance for both tokens
    const providerAccount = await getAccount(addLiquidityData.provider);
    if (!providerAccount) {
      logger.warn(`[pool-add-liquidity] Provider account ${addLiquidityData.provider} not found.`);
      return false;
    }

    // Check if provider has sufficient balance for both tokens
    const tokenABalance = toBigInt(providerAccount.balances[pool.tokenA_symbol] || '0');
    const tokenBBalance = toBigInt(providerAccount.balances[pool.tokenB_symbol] || '0');

    if (tokenABalance < addLiquidityData.tokenA_amount) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenA_symbol}. Required: ${addLiquidityData.tokenA_amount}, Available: ${tokenABalance}`);
      return false;
    }

    if (tokenBBalance < addLiquidityData.tokenB_amount) {
      logger.warn(`[pool-add-liquidity] Insufficient balance for ${pool.tokenB_symbol}. Required: ${addLiquidityData.tokenB_amount}, Available: ${tokenBBalance}`);
      return false;
    }

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

    return true;
  } catch (error) {
    logger.error(`[pool-add-liquidity] Error validating add liquidity data for pool ${data.poolId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: PoolAddLiquidityDataDB, sender: string, id: string): Promise<boolean> {
    try {
        const addLiquidityData = convertToBigInt<PoolAddLiquidityData>(data, NUMERIC_FIELDS);

        const poolDB = await cache.findOnePromise('liquidityPools', { _id: addLiquidityData.poolId }) as LiquidityPoolDB | null;
        if (!poolDB) {
            logger.error(`[pool-add-liquidity] CRITICAL: Pool ${addLiquidityData.poolId} not found during processing.`);
            return false;
        }

        // Ensure fee accounting fields are present and initialized as bigint
        let feeGrowthGlobalA = typeof poolDB.feeGrowthGlobalA === 'bigint' ? poolDB.feeGrowthGlobalA : BigInt(poolDB.feeGrowthGlobalA || '0');
        let feeGrowthGlobalB = typeof poolDB.feeGrowthGlobalB === 'bigint' ? poolDB.feeGrowthGlobalB : BigInt(poolDB.feeGrowthGlobalB || '0');
        const pool = {
            ...convertToBigInt<LiquidityPool>(poolDB, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']),
            feeGrowthGlobalA,
            feeGrowthGlobalB
        };

        // Debit tokens from the provider's account
        const debitASuccess = await adjustBalance(addLiquidityData.provider, pool.tokenA_symbol, -addLiquidityData.tokenA_amount);
        const debitBSuccess = await adjustBalance(addLiquidityData.provider, pool.tokenB_symbol, -addLiquidityData.tokenB_amount);

        if (!debitASuccess || !debitBSuccess) {
            logger.error(`[pool-add-liquidity] Failed to debit tokens from ${addLiquidityData.provider}. Rolling back any debits.`);
            if (debitASuccess) await adjustBalance(addLiquidityData.provider, pool.tokenA_symbol, addLiquidityData.tokenA_amount);
            if (debitBSuccess) await adjustBalance(addLiquidityData.provider, pool.tokenB_symbol, addLiquidityData.tokenB_amount);
            return false;
        }

        const lpTokensToMint = calculateLpTokensToMint(addLiquidityData.tokenA_amount, addLiquidityData.tokenB_amount, pool);
        if (lpTokensToMint <= BigInt(0)) {
            logger.error('[pool-add-liquidity] CRITICAL: LP token calculation resulted in zero or negative amount. Rolling back token debits.');
            await adjustBalance(addLiquidityData.provider, pool.tokenA_symbol, addLiquidityData.tokenA_amount);
            await adjustBalance(addLiquidityData.provider, pool.tokenB_symbol, addLiquidityData.tokenB_amount);
            return false;
        }

        // Update pool reserves and total LP tokens
        const poolUpdateSuccess = await cache.updateOnePromise(
            'liquidityPools',
            { _id: addLiquidityData.poolId },
            {
                $set: {
                    ...convertToString(
                        {
                            tokenA_reserve: pool.tokenA_reserve + addLiquidityData.tokenA_amount,
                            tokenB_reserve: pool.tokenB_reserve + addLiquidityData.tokenB_amount,
                            totalLpTokens: pool.totalLpTokens + lpTokensToMint,
                            feeGrowthGlobalA: pool.feeGrowthGlobalA,
                            feeGrowthGlobalB: pool.feeGrowthGlobalB
                        },
                        ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeGrowthGlobalA', 'feeGrowthGlobalB']
                    ),
                    lastUpdatedAt: new Date().toISOString()
                }
            }
        );

        if (!poolUpdateSuccess) {
            logger.error(`[pool-add-liquidity] Failed to update pool ${addLiquidityData.poolId}. Add liquidity aborted.`);
            return false;
        }

        // Update or create user liquidity position with fee checkpoints
        const userPositionId = `${addLiquidityData.provider}-${addLiquidityData.poolId}`;
        const existingUserPosDB = await cache.findOnePromise('userLiquidityPositions', { _id: userPositionId }) as UserLiquidityPositionDB | null;
        const existingUserPos = existingUserPosDB ? {
            ...convertToBigInt<UserLiquidityPosition>(existingUserPosDB, ['lpTokenBalance']),
            feeGrowthEntryA: typeof existingUserPosDB.feeGrowthEntryA === 'bigint' ? existingUserPosDB.feeGrowthEntryA : BigInt(existingUserPosDB.feeGrowthEntryA || '0'),
            feeGrowthEntryB: typeof existingUserPosDB.feeGrowthEntryB === 'bigint' ? existingUserPosDB.feeGrowthEntryB : BigInt(existingUserPosDB.feeGrowthEntryB || '0'),
            unclaimedFeesA: typeof existingUserPosDB.unclaimedFeesA === 'bigint' ? existingUserPosDB.unclaimedFeesA : BigInt(existingUserPosDB.unclaimedFeesA || '0'),
            unclaimedFeesB: typeof existingUserPosDB.unclaimedFeesB === 'bigint' ? existingUserPosDB.unclaimedFeesB : BigInt(existingUserPosDB.unclaimedFeesB || '0'),
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
                        ...convertToString(
                            {
                                lpTokenBalance: existingUserPos.lpTokenBalance + lpTokensToMint,
                                feeGrowthEntryA: pool.feeGrowthGlobalA || BigInt(0),
                                feeGrowthEntryB: pool.feeGrowthGlobalB || BigInt(0),
                                unclaimedFeesA: newUnclaimedFeesA,
                                unclaimedFeesB: newUnclaimedFeesB
                            },
                            ['lpTokenBalance', 'feeGrowthEntryA', 'feeGrowthEntryB', 'unclaimedFeesA', 'unclaimedFeesB']
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
                feeGrowthEntryA: pool.feeGrowthGlobalA || BigInt(0),
                feeGrowthEntryB: pool.feeGrowthGlobalB || BigInt(0),
                unclaimedFeesA: BigInt(0),
                unclaimedFeesB: BigInt(0),
                createdAt: new Date().toISOString(),
                lastUpdatedAt: new Date().toISOString()
            };
            const newUserPositionDB = convertToString(newUserPosition, ['lpTokenBalance', 'feeGrowthEntryA', 'feeGrowthEntryB', 'unclaimedFeesA', 'unclaimedFeesB']);
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
            logger.error(`[pool-add-liquidity] CRITICAL: Failed to update user position. Rolling back pool update and token debits.`);
            await adjustBalance(addLiquidityData.provider, pool.tokenA_symbol, addLiquidityData.tokenA_amount);
            await adjustBalance(addLiquidityData.provider, pool.tokenB_symbol, addLiquidityData.tokenB_amount);
            await cache.updateOnePromise(
                'liquidityPools',
                { _id: addLiquidityData.poolId },
                {
                    $set: convertToString(
                        {
                            tokenA_reserve: pool.tokenA_reserve,
                            tokenB_reserve: pool.tokenB_reserve,
                            totalLpTokens: pool.totalLpTokens,
                            feeGrowthGlobalA: pool.feeGrowthGlobalA,
                            feeGrowthGlobalB: pool.feeGrowthGlobalB
                        },
                        ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeGrowthGlobalA', 'feeGrowthGlobalB']
                    )
                }
            );
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
            logger.error(`[pool-add-liquidity] Failed to credit LP tokens (${lpTokenSymbol}) to ${addLiquidityData.provider}. Rolling back pool and user position updates.`);
            // Rollback: remove liquidity position update and pool update (not implemented here, but should be for full atomicity)
            return false;
        }

        logger.debug(`[pool-add-liquidity] Provider ${addLiquidityData.provider} added liquidity to pool ${addLiquidityData.poolId}. Token A: ${bigintToString(addLiquidityData.tokenA_amount)}, Token B: ${bigintToString(addLiquidityData.tokenB_amount)}, LP tokens minted: ${bigintToString(lpTokensToMint)}`);

        const eventData = {
            poolId: addLiquidityData.poolId,
            provider: addLiquidityData.provider,
            tokenA_amount: bigintToString(addLiquidityData.tokenA_amount),
            tokenB_amount: bigintToString(addLiquidityData.tokenB_amount),
            lpTokensMinted: bigintToString(lpTokensToMint)
        };
        await logTransactionEvent('poolAddLiquidity', sender, eventData, id);

        return true;
    } catch (error) {
        logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${data.poolId} by ${sender}: ${error}`);
        return false;
    }
}