import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolSwapData, LiquidityPool } from './pool-interfaces.js';
import { adjustBalance, getAccount, Account } from '../../utils/account-utils.js';
import { BigIntMath } from '../../utils/bigint-utils.js';

const SWAP_FEE_RATE = 0.003; // 0.3% swap fee

// Helper to parse string amounts to numbers, returns 0 if invalid
function parseAmount(amountStr: string | undefined): number {
    if (amountStr === undefined) return 0;
    const amount = parseFloat(amountStr);
    return isNaN(amount) || amount < 0 ? 0 : amount;
}

export async function validateTx(data: PoolSwapData, sender: string): Promise<boolean> {
    try {
        if (sender !== data.trader) {
            logger.warn('[pool-swap] Sender must be the trader.');
            return false;
        }

        if (!BigIntMath.isPositive(data.amountIn)) {
            logger.warn('[pool-swap] amountIn must be a positive number.');
            return false;
        }

        if (data.minAmountOut && !BigIntMath.isPositive(data.minAmountOut)) {
            logger.warn('[pool-swap] minAmountOut must be a positive number.');
            return false;
        }

        const traderAccount = await getAccount(data.trader);
        if (!traderAccount) {
            logger.warn(`[pool-swap] Trader account ${data.trader} not found.`);
            return false;
        }

        // Get pool data
        const pool = await cache.findOnePromise('pools', { _id: data.poolId }) as LiquidityPool | null;
        if (!pool) {
            logger.warn(`[pool-swap] Pool ${data.poolId} not found.`);
            return false;
        }

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

        // Check trader balance
        const tokenInIdentifier = `${data.tokenIn_symbol}@${pool.tokenA_symbol === data.tokenIn_symbol ? pool.tokenA_issuer : pool.tokenB_issuer}`;
        const traderBalance = BigIntMath.toBigInt(traderAccount.balances?.[tokenInIdentifier] || 0);
        if (traderBalance < data.amountIn) {
            logger.warn(`[pool-swap] Insufficient balance. Has ${traderBalance}, needs ${data.amountIn}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
        return false;
    }
}

// Helper to calculate swap output amount (constant product formula with fee)
function calculateSwapAmountOut(
    amountIn: number,
    reserveIn: number,
    reserveOut: number,
    poolFeeRate: number // Use specific pool's fee rate
): number {
    if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
    const amountInAfterFee = amountIn * (1 - poolFeeRate);
    const numerator = reserveOut * amountInAfterFee;
    const denominator = reserveIn + amountInAfterFee;
    if (denominator === 0) return 0;
    return numerator / denominator;
}

export async function process(data: PoolSwapData, sender: string): Promise<boolean> {
    return handlePoolSwap(data);
}

export async function handlePoolSwap(data: PoolSwapData): Promise<boolean> {
    // Get pool data
    const pool = await cache.findOnePromise('pools', { _id: data.poolId }) as LiquidityPool | null;
    if (!pool) {
        logger.warn(`[pool-swap] Pool ${data.poolId} not found.`);
        return false;
    }

    // Determine token indices
    const tokenInIndex = data.tokenIn_symbol === pool.tokenA_symbol ? 'A' : 'B';
    const tokenOutIndex = tokenInIndex === 'A' ? 'B' : 'A';

    // Get token identifiers
    const tokenInIdentifier = `${pool[`token${tokenInIndex}_symbol`]}@${pool[`token${tokenInIndex}_issuer`]}`;
    const tokenOutIdentifier = `${pool[`token${tokenOutIndex}_symbol`]}@${pool[`token${tokenOutIndex}_issuer`]}`;

    // Calculate output amount using constant product formula (x * y = k)
    const reserveIn = BigIntMath.toBigInt(pool[`token${tokenInIndex}_reserve`]);
    const reserveOut = BigIntMath.toBigInt(pool[`token${tokenOutIndex}_reserve`]);

    // Using constant product formula: (x + dx)(y - dy) = k = x * y
    // Solving for dy: dy = y * dx / (x + dx)
    const amountInWithFee = BigIntMath.mul(data.amountIn, BigInt(997)); // 0.3% fee
    const numerator = BigIntMath.mul(amountInWithFee, reserveOut);
    const denominator = BigIntMath.add(BigIntMath.mul(reserveIn, BigInt(1000)), amountInWithFee);
    const amountOut = BigIntMath.div(numerator, denominator);

    // Ensure minimum output amount is met
    if (data.minAmountOut && amountOut < data.minAmountOut) {
        logger.warn('[pool-swap] Output amount is less than minimum required.');
        return false;
    }

    // Update pool reserves
    const newReserveIn = BigIntMath.add(reserveIn, data.amountIn);
    const newReserveOut = BigIntMath.sub(reserveOut, amountOut);

    // Update user balances
    const trader = await getAccount(data.trader);
    if (!trader) {
        logger.warn(`[pool-swap] Trader account ${data.trader} not found.`);
        return false;
    }

    // Adjust balances using BigInt values
    await adjustBalance(data.trader, tokenInIdentifier, -data.amountIn);
    await adjustBalance(data.trader, tokenOutIdentifier, amountOut);

    // Save updated pool state
    const updateSuccess = await cache.updateOnePromise('pools', { _id: data.poolId }, {
        $set: {
            [`token${tokenInIndex}_reserve`]: newReserveIn,
            [`token${tokenOutIndex}_reserve`]: newReserveOut,
            lastTradeAt: new Date().toISOString()
        }
    });

    if (!updateSuccess) {
        logger.error(`[pool-swap] Failed to update pool ${data.poolId} reserves.`);
        return false;
    }

    logger.info(`[pool-swap] Successful swap in pool ${data.poolId}: ${data.amountIn} ${tokenInIdentifier} -> ${amountOut} ${tokenOutIdentifier}`);
    return true;
} 