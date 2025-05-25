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
        const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);

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
        const tokenInIssuer = pool.tokenA_symbol === data.tokenIn_symbol ? pool.tokenA_issuer : pool.tokenB_issuer;
        const tokenInIdentifier = `${data.tokenIn_symbol}@${tokenInIssuer}`;
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

export async function process(transaction: { data: PoolSwapDataDB, sender: string, _id: string }): Promise<boolean> {
    const { data: dataDb, sender, _id: transactionId } = transaction;
    const data = convertToBigInt<PoolSwapData>(dataDb, NUMERIC_FIELDS_SWAP);

    // Get pool data
    const poolFromDb = await cache.findOnePromise('liquidityPools', { _id: data.poolId }) as LiquidityPoolDB | null;
    if (!poolFromDb) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found during processing.`);
        return false;
    }
    const pool = convertToBigInt<LiquidityPool>(poolFromDb, ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier']);

    // Determine token indices
    const tokenInIndex = data.tokenIn_symbol === pool.tokenA_symbol ? 'A' : 'B';
    const tokenOutIndex = tokenInIndex === 'A' ? 'B' : 'A';

    // Get token identifiers including issuers from the pool document
    const tokenIn_symbol = pool[`token${tokenInIndex}_symbol`];
    const tokenIn_issuer = pool[`token${tokenInIndex}_issuer`];
    const tokenOut_symbol = pool[`token${tokenOutIndex}_symbol`];
    const tokenOut_issuer = pool[`token${tokenOutIndex}_issuer`];

    const tokenInIdentifier = `${tokenIn_symbol}@${tokenIn_issuer}`;
    const tokenOutIdentifier = `${tokenOut_symbol}@${tokenOut_issuer}`;

    // Calculate output amount using constant product formula (x * y = k)
    const reserveIn = pool[`token${tokenInIndex}_reserve`];
    const reserveOut = pool[`token${tokenOutIndex}_reserve`];

    // Using constant product formula: (x + dx)(y - dy) = k = x * y
    // dy = y - k / (x + dx) = y - (x*y) / (x + dx_after_fee)
    // amountOut = reserveOut - (reserveIn * reserveOut) / (reserveIn + amountIn_after_fee)
    // Simplified: amountOut = (reserveOut * amountIn_after_fee) / (reserveIn_before_fee + amountIn_after_fee)
    // Fee is typically applied to amountIn. Let's assume a 0.3% fee (multiply by 997, divide by 1000)
    // The feeTier from the pool interface is in basis points (e.g., 30 for 0.3%)
    const feeMultiplier = BigInt(10000) - pool.feeTier; // e.g., 10000 - 30 = 9970
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
    const deductSuccess = await adjustBalance(data.trader, tokenInIdentifier, BigIntMath.mul(data.amountIn, BigInt(-1)));
    if (!deductSuccess) {
        logger.error(`[pool-swap] Failed to deduct ${bigintToString(data.amountIn)} ${tokenInIdentifier} from ${data.trader}.`);
        return false; // Or attempt rollback? For now, fail.
    }
    const creditSuccess = await adjustBalance(data.trader, tokenOutIdentifier, amountOut);
    if (!creditSuccess) {
        logger.error(`[pool-swap] Failed to credit ${bigintToString(amountOut)} ${tokenOutIdentifier} to ${data.trader}. Rolling back deduction.`);
        // Rollback deduction
        await adjustBalance(data.trader, tokenInIdentifier, data.amountIn); // Credit back
        return false;
    }

    // Save updated pool state
    const poolUpdateSet: any = {
        lastTradeAt: new Date().toISOString()
    };
    poolUpdateSet[`token${tokenInIndex}_reserve`] = bigintToString(newReserveIn);
    poolUpdateSet[`token${tokenOutIndex}_reserve`] = bigintToString(newReserveOut);

    const updateSuccess = await cache.updateOnePromise('liquidityPools', { _id: data.poolId }, {
        $set: poolUpdateSet
    });

    if (!updateSuccess) {
        logger.error(`[pool-swap] Failed to update pool ${data.poolId} reserves. Critical: Balances changed but pool reserves not. Manual fix needed or implement full rollback.`);
        // Attempt to rollback balance changes
        await adjustBalance(data.trader, tokenOutIdentifier, BigIntMath.mul(amountOut, BigInt(-1))); // Deduct credited amountOut
        await adjustBalance(data.trader, tokenInIdentifier, data.amountIn); // Credit back original amountIn
        return false;
    }

    logger.info(`[pool-swap] Successful swap by ${sender} in pool ${data.poolId}: ${bigintToString(data.amountIn)} ${tokenInIdentifier} -> ${bigintToString(amountOut)} ${tokenOutIdentifier}`);

    // Log event
    const eventData = {
        poolId: data.poolId,
        trader: sender, // or data.trader, should be same
        tokenIn_symbol: tokenIn_symbol,
        tokenIn_issuer: tokenIn_issuer,
        amountIn: bigintToString(data.amountIn),
        tokenOut_symbol: tokenOut_symbol,
        tokenOut_issuer: tokenOut_issuer,
        amountOut: bigintToString(amountOut),
        feeTier: bigintToString(pool.feeTier), // Log the fee tier used
        // transactionId: transactionId // Already passed to logTransactionEvent
    };
    await logTransactionEvent('poolSwap', sender, eventData, transactionId);

    return true;
} 