import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, LiquidityPool, PoolSwapDataDB, LiquidityPoolDB } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';
import { BigIntMath, convertToBigInt, toString as bigintToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

// const SWAP_FEE_RATE = 0.003; // 0.3% swap fee - This constant is not used in the BigInt logic below which uses 997/1000 factor

const NUMERIC_FIELDS_SWAP: Array<keyof PoolSwapData> = ['amountIn', 'minAmountOut'];

export async function validateTx(dataDb: PoolSwapDataDB, sender: string): Promise<boolean> {
    try {
        const data = convertToBigInt<PoolSwapData>(dataDb, NUMERIC_FIELDS_SWAP);

        if (sender !== data.trader) {
            logger.warn('[pool-swap] Sender must be the trader.');
            return false;
        }

        if (!BigIntMath.isPositive(data.amountIn)) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return false;
        }

        if (data.minAmountOut !== undefined && !BigIntMath.isPositive(data.minAmountOut)) {
            logger.warn('[pool-swap] minAmountOut, if provided, must be a positive BigInt.');
            return false;
        }

        const traderAccount = await getAccount(data.trader);
        if (!traderAccount) {
            logger.warn(`[pool-swap] Trader account ${data.trader} not found.`);
            return false;
        }

        // Get pool data
        const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
        if (!poolFromDb) {
            logger.warn(`[pool-swap] Pool ${data.poolId} not found.`);
            return false;
        }
        const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

        // Verify token symbols match
        if (!((pool.tokenA_symbol === data.tokenIn_symbol && pool.tokenB_symbol === data.tokenOut_symbol) ||
              (pool.tokenB_symbol === data.tokenIn_symbol && pool.tokenA_symbol === data.tokenOut_symbol))) {
            logger.warn('[pool-swap] Token symbols do not match pool configuration.');
            return false;
        }

        // Check pool liquidity
        if (BigIntMath.isZero(pool.tokenA_reserve) || BigIntMath.isZero(pool.tokenB_reserve)) {
            logger.warn(`[pool-swap] Pool ${data.poolId} has insufficient liquidity.`);
            return false;
        }

        // Determine token issuers from the validated pool data for correct balance check
        const tokenInIdentifier = data.tokenIn_symbol;
        const traderBalance = BigIntMath.toBigInt(traderAccount.balances?.[tokenInIdentifier] || '0');
        if (traderBalance < data.amountIn) {
            logger.warn(`[pool-swap] Insufficient balance for ${tokenInIdentifier}. Has ${bigintToString(traderBalance)}, needs ${bigintToString(data.amountIn)}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
        return false;
    }
}

export async function process(dataDb: PoolSwapDataDB, sender: string, transactionId: string): Promise<boolean> {
    const data = convertToBigInt<PoolSwapData>(dataDb, NUMERIC_FIELDS_SWAP);

    // Get pool data
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found during processing.`);
        return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens']);

    // Determine token indices
    const tokenInIsA = data.tokenIn_symbol === pool.tokenA_symbol;
    const tokenIn_symbol = tokenInIsA ? pool.tokenA_symbol : pool.tokenB_symbol;
    const tokenOut_symbol = tokenInIsA ? pool.tokenB_symbol : pool.tokenA_symbol;
    const reserveIn = tokenInIsA ? pool.tokenA_reserve : pool.tokenB_reserve;
    const reserveOut = tokenInIsA ? pool.tokenB_reserve : pool.tokenA_reserve;

    // Calculate output amount using constant product formula (x * y = k)
    // Fee tiers are in basis points: 10 = 0.01%, 50 = 0.05%, 300 = 0.3%, 1000 = 1%
    const feeMultiplier = BigInt(10000) - BigInt(pool.feeTier); // e.g., 10000 - 300 = 9700 for 0.3% fee
    const feeDivisor = BigInt(10000);

    const amountInAfterFee = BigIntMath.div(BigIntMath.mul(data.amountIn, feeMultiplier), feeDivisor);

    const numerator = BigIntMath.mul(amountInAfterFee, reserveOut);
    const denominator = BigIntMath.add(reserveIn, amountInAfterFee);
    
    if (BigIntMath.isZero(denominator)) {
        logger.error(`[pool-swap] CRITICAL: Denominator is zero in swap calculation for pool ${data.poolId}. reserveIn: ${bigintToString(reserveIn)}, amountInAfterFee: ${bigintToString(amountInAfterFee)}`);
        return false;
    }
    const amountOut = BigIntMath.div(numerator, denominator);

    if (BigIntMath.isZero(amountOut)) {
        logger.warn(`[pool-swap] Calculated swap amountOut is zero for pool ${data.poolId}. amountIn: ${bigintToString(data.amountIn)}, reserveIn: ${bigintToString(reserveIn)}, reserveOut: ${bigintToString(reserveOut)}`);
        // Allow zero amount out if minAmountOut is zero or not specified, but log it.
        if (data.minAmountOut && data.minAmountOut > BigInt(0)) {
             logger.warn(`[pool-swap] Output amount is zero and minAmountOut is ${bigintToString(data.minAmountOut)}. Swap failed.`);
             return false;
        }
    }

    // Ensure minimum output amount is met
    if (data.minAmountOut && amountOut < data.minAmountOut) {
        logger.warn(`[pool-swap] Output amount ${bigintToString(amountOut)} is less than minimum required ${bigintToString(data.minAmountOut)}.`);
        return false;
    }

    // Update pool reserves
    const newReserveIn = BigIntMath.add(reserveIn, data.amountIn);
    const newReserveOut = BigIntMath.sub(reserveOut, amountOut);

    // Update user balances
    const deductSuccess = await adjustBalance(data.trader, tokenIn_symbol, -data.amountIn);
    if (!deductSuccess) {
        logger.error(`[pool-swap] Failed to deduct ${bigintToString(data.amountIn)} ${tokenIn_symbol} from ${data.trader}.`);
        return false;
    }
    const creditSuccess = await adjustBalance(data.trader, tokenOut_symbol, amountOut);
    if (!creditSuccess) {
        logger.error(`[pool-swap] Failed to credit ${bigintToString(amountOut)} ${tokenOut_symbol} to ${data.trader}. Rolling back deduction.`);
        await adjustBalance(data.trader, tokenIn_symbol, data.amountIn); // Credit back
        return false;
    }

    // Save updated pool state
    const poolUpdateSet: any = {
        lastTradeAt: new Date().toISOString()
    };
    if (tokenInIsA) {
        poolUpdateSet.tokenA_reserve = bigintToString(newReserveIn);
        poolUpdateSet.tokenB_reserve = bigintToString(newReserveOut);
    } else {
        poolUpdateSet.tokenB_reserve = bigintToString(newReserveIn);
        poolUpdateSet.tokenA_reserve = bigintToString(newReserveOut);
    }
    
    const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
        $set: poolUpdateSet
    });

    if (!updateSuccess) {
        logger.error(`[pool-swap] Failed to update pool ${data.poolId} reserves. Critical: Balances changed but pool reserves not. Rolling back balance changes.`);
        // Attempt to rollback balance changes
        await adjustBalance(data.trader, tokenOut_symbol, -amountOut); // Deduct credited amountOut
        await adjustBalance(data.trader, tokenIn_symbol, data.amountIn); // Credit back original amountIn
        return false;
    }

    logger.info(`[pool-swap] Successful swap by ${sender} in pool ${data.poolId}: ${bigintToString(data.amountIn)} ${tokenIn_symbol} -> ${bigintToString(amountOut)} ${tokenOut_symbol}`);

    // Log event
    const eventData = {
        poolId: data.poolId,
        trader: sender,
        tokenIn_symbol: tokenIn_symbol,
        amountIn: bigintToString(data.amountIn),
        tokenOut_symbol: tokenOut_symbol,
        amountOut: bigintToString(amountOut),
        feeTier: pool.feeTier,
    };
    await logTransactionEvent('poolSwap', sender, eventData, transactionId);

    return true;
} 