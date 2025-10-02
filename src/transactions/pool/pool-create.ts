import logger from '../../logger.js';
import { logEvent } from '../../utils/event-logger.js';
import { generatePoolId } from '../../utils/pool.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { createLiquidityPool, createLpToken, createTradingPair } from './pool-helpers.js';
import { PoolData } from './pool-interfaces.js';

export async function validateTx(data: PoolData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!validate.validatePoolTokens(data)) {
            return { valid: false, error: 'invalid pool tokens' };
        }
        if (!(await validate.tokenExists(data.tokenA_symbol)) || !(await validate.tokenExists(data.tokenB_symbol))) {
            return { valid: false, error: 'one or both tokens do not exist' };
        }
        const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol);
        if (await validate.poolExists(poolId)) return { valid: false, error: 'pool already exists' };
        return { valid: true };
    } catch (error) {
        logger.error(`[pool-create] Error validating data for pool by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: PoolData, sender: string, id: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol);
        const lpTokenSymbol = getLpTokenSymbol(data.tokenA_symbol, data.tokenB_symbol);
        const poolSuccess = await createLiquidityPool(poolId, data.tokenA_symbol, data.tokenB_symbol);
        if (!poolSuccess) {
            return { valid: false, error: 'failed to create liquidity pool' };
        }
        logger.debug(
            `[pool-create] Liquidity Pool ${poolId} (${data.tokenA_symbol}_${data.tokenB_symbol}, Fee: 0.3%) created by ${sender}. LP Token: ${lpTokenSymbol}`
        );
        const lpTokenSuccess = await createLpToken(data.tokenA_symbol, data.tokenB_symbol, poolId);
        if (!lpTokenSuccess) {
            return { valid: false, error: 'failed to create LP token' };
        }
        const tradingPairSuccess = await createTradingPair(poolId, data.tokenA_symbol, data.tokenB_symbol, sender, id);
        if (!tradingPairSuccess) {
            logger.warn(`[pool-create] Pool created but trading pair creation failed for ${poolId}`);
            return { valid: false, error: 'failed to create trading pair' };
        }
        const poolData = {
            poolId,
            tokenA: data.tokenA_symbol,
            tokenB: data.tokenB_symbol,
            initialLiquidity: {
                tokenAAmount: '0',
                tokenBAmount: '0',
            },
        };
        await logEvent('defi', 'pool_created', sender, poolData, id);
        return { valid: true };
    } catch (error) {
        logger.error(`[pool-create] Error processing pool creation by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
