import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolData } from './pool-interfaces.js';
import config from '../../config.js';
import { generatePoolId } from '../../utils/pool.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { logEvent } from '../../utils/event-logger.js';
import { createLiquidityPool, createLpToken, createTradingPair } from './pool-helpers.js';


export async function validateTx(data: PoolData, sender: string): Promise<boolean> {
  try {
    if (!validate.validatePoolTokens(data)) {
      return false;
    }

    if (!await validate.tokenExists(data.tokenA_symbol) || !await validate.tokenExists(data.tokenB_symbol)) {
      return false;
    }

    const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol);

    if (await validate.poolExists(poolId)) return false;

    return true;
  } catch (error) {
    logger.error(`[pool-create] Error validating data for pool by ${sender}: ${error}`);
    return false;
  }
}

export async function processTx(data: PoolData, sender: string, id: string): Promise<boolean> {
  try {
    const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol);
    const lpTokenSymbol = getLpTokenSymbol(data.tokenA_symbol, data.tokenB_symbol);

    // Create the liquidity pool
    const poolSuccess = await createLiquidityPool(poolId, data.tokenA_symbol, data.tokenB_symbol);
    if (!poolSuccess) {
      return false;
    }

    logger.debug(`[pool-create] Liquidity Pool ${poolId} (${data.tokenA_symbol}_${data.tokenB_symbol}, Fee: 0.3%) created by ${sender}. LP Token: ${lpTokenSymbol}`);

    // Create the LP token
    const lpTokenSuccess = await createLpToken(data.tokenA_symbol, data.tokenB_symbol, poolId);
    if (!lpTokenSuccess) {
      return false;
    }

    // Create trading pair
    const tradingPairSuccess = await createTradingPair(poolId, data.tokenA_symbol, data.tokenB_symbol, sender, id);
    if (!tradingPairSuccess) {
      logger.warn(`[pool-create] Pool created but trading pair creation failed for ${poolId}`);
      return false
    }

    await logEvent('defi', 'pool_created', sender, {
      poolId,
      tokenA: data.tokenA_symbol,
      tokenB: data.tokenB_symbol,
      initialLiquidity: {
        tokenAAmount: '0',
        tokenBAmount: '0'
      }
    }, id);

    return true;
  } catch (error) {
    logger.error(`[pool-create] Error processing pool creation by ${sender}: ${error}`);
    return false;
  }
} 