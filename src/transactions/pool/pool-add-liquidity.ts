import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { calculateLpTokensToMint } from '../../utils/pool.js';
import { poolExists, validateLpTokenExists, validatePoolAddLiquidityFields, validatePoolRatioTolerance, validateUserBalances } from '../../validation/pool.js';
import { creditLpTokens, debitLiquidityTokens, updatePoolReserves, updateUserLiquidityPosition } from './pool-helpers.js';
import { LiquidityPoolData, PoolAddLiquidityData } from './pool-interfaces.js';

export async function validateTx(data: PoolAddLiquidityData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        // Validate required fields and sender
        if (!validatePoolAddLiquidityFields(data)) {
            return { valid: false, error: 'Invalid pool add liquidity fields' };
        }

        // Validate pool exists
        const pool = await poolExists(data.poolId);
        if (!pool) {
            return { valid: false, error: 'Pool does not exist' };
        }

        // Validate user balances
        if (!(await validateUserBalances(sender, pool.tokenA_symbol, pool.tokenB_symbol, data.tokenA_amount, data.tokenB_amount))) {
            return { valid: false, error: 'Insufficient user balances' };
        }

        // Validate pool ratio tolerance
        if (!validatePoolRatioTolerance(pool, data.tokenA_amount, data.tokenB_amount)) {
            return { valid: false, error: 'Invalid pool ratio tolerance' };
        }

        // Validate LP token exists
        if (!(await validateLpTokenExists(pool.tokenA_symbol, pool.tokenB_symbol, data.poolId))) {
            return { valid: false, error: 'LP token does not exist' };
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[pool-add-liquidity] Error validating add liquidity data for pool ${data.poolId} by ${sender}: ${error}`);
        return { valid: false, error: 'Validation error' };
    }
}

export async function processTx(data: PoolAddLiquidityData, sender: string, id: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const poolDB = (await cache.findOnePromise('liquidityPools', { _id: data.poolId })) as LiquidityPoolData; // validateTx guarantees existence

        // Prepare pool data with fee accounting fields
        const pool = {
            ...poolDB,
            feeGrowthGlobalA: toBigInt(poolDB.feeGrowthGlobalA || 0),
            feeGrowthGlobalB: toBigInt(poolDB.feeGrowthGlobalB || 0),
        };

        // Debit tokens from the provider's account
        if (!(await debitLiquidityTokens(sender, pool.tokenA_symbol, pool.tokenB_symbol, data.tokenA_amount, data.tokenB_amount))) {
            return { valid: false, error: 'Failed to debit liquidity tokens' };
        }

        // Calculate LP tokens to mint
        const lpTokensToMint = calculateLpTokensToMint(toBigInt(data.tokenA_amount), toBigInt(data.tokenB_amount), pool);
        if (lpTokensToMint <= toBigInt(0)) {
            logger.error('[pool-add-liquidity] Insufficient liquidity amount. For initial liquidity, provide more tokens to meet minimum requirements.');
            return { valid: false, error: 'Insufficient liquidity amount' };
        }

        // Update pool reserves and total LP tokens
        if (!(await updatePoolReserves(data.poolId, pool, data.tokenA_amount, data.tokenB_amount, lpTokensToMint))) {
            return { valid: false, error: 'Failed to update pool reserves' };
        }

        // Update or create user liquidity position
        if (!(await updateUserLiquidityPosition(sender, data.poolId, lpTokensToMint, pool))) {
            return { valid: false, error: 'Failed to update user liquidity position' };
        }

        // Credit LP tokens to user account
        if (!(await creditLpTokens(sender, pool.tokenA_symbol, pool.tokenB_symbol, lpTokensToMint, data.poolId))) {
            return { valid: false, error: 'Failed to credit LP tokens' };
        }

        logger.debug(
            `[pool-add-liquidity] Provider ${sender} added liquidity to pool ${data.poolId}. Token A: ${data.tokenA_amount}, Token B: ${data.tokenB_amount}, LP tokens minted: ${lpTokensToMint}`
        );

        // Log event
        await logEvent(
            'defi',
            'liquidity_added',
            sender,
            {
                poolId: data.poolId,
                tokenAAmount: toDbString(data.tokenA_amount),
                tokenBAmount: toDbString(data.tokenB_amount),
                lpTokensMinted: toDbString(lpTokensToMint),
            },
            id
        );

        return { valid: true };
    } catch (error) {
        logger.error(`[pool-add-liquidity] Error processing add liquidity for pool ${data.poolId} by ${sender}: ${error}`);
        return { valid: false, error: 'Processing error' };
    }
}
