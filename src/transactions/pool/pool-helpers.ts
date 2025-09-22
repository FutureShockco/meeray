import logger from '../../logger.js';
import cache from '../../cache.js';
import { LiquidityPoolData } from './pool-interfaces.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';

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
