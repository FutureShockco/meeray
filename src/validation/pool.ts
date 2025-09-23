import cache from '../cache.js';
import config from '../config.js';
import logger from '../logger.js';
import { LiquidityPoolData } from '../transactions/pool/pool-interfaces.js';
import { getAccount } from '../utils/account.js';
import { toBigInt } from '../utils/bigint.js';
import { getLpTokenSymbol } from '../utils/token.js';
import validate from './index.js';

/**
 * Validates that the required fields are present in pool add liquidity data
 * @param data Pool add liquidity data
 * @param sender Transaction sender
 * @returns True if required fields are valid, false otherwise
 */
export const validatePoolTokens = (data: any): boolean => {
    if (!data.tokenA_symbol || !data.tokenB_symbol) {
        logger.warn('[pool-create] Invalid data: Missing required token symbols.');
        return false;
    }

    if (!validate.string(data.tokenA_symbol, 10, 3, config.tokenSymbolAllowedChars)) {
        logger.warn(`[pool-create] Invalid tokenA_symbol: ${data.tokenA_symbol}.`);
        return false;
    }
    if (!validate.string(data.tokenB_symbol, 10, 3, config.tokenSymbolAllowedChars)) {
        logger.warn(`[pool-create] Invalid tokenB_symbol: ${data.tokenB_symbol}.`);
        return false;
    }

    if (data.tokenA_symbol === data.tokenB_symbol) {
        logger.warn('[pool-create] Cannot create a pool with the same token on both sides.');
        return false;
    }
    return true;
};

/**
 * Validates that the required fields are present in pool add liquidity data
 * @param data Pool add liquidity data
 * @param sender Transaction sender
 * @returns True if required fields are valid, false otherwise
 */
export const validatePoolAddLiquidityFields = (data: any): boolean => {
    if (!data.poolId || !data.tokenA_amount || !data.tokenB_amount) {
        logger.warn('[pool-validation] Invalid data: Missing required fields.');
        return false;
    }

    return true;
};

/**
 * Validates that the user has sufficient token balances
 * @param user User account name
 * @param tokenASymbol Token A symbol
 * @param tokenBSymbol Token B symbol
 * @param tokenAAmount Required token A amount
 * @param tokenBAmount Required token B amount
 * @returns True if balances are sufficient, false otherwise
 */
export const validateUserBalances = async (
    user: string,
    tokenASymbol: string,
    tokenBSymbol: string,
    tokenAAmount: string | bigint,
    tokenBAmount: string | bigint
): Promise<boolean> => {
    const userAccount = await getAccount(user);
    if (!userAccount) {
        logger.warn(`[pool-validation] User account ${user} not found.`);
        return false;
    }

    const tokenABalance = toBigInt(userAccount.balances[tokenASymbol] || '0');
    const tokenBBalance = toBigInt(userAccount.balances[tokenBSymbol] || '0');

    if (tokenABalance < toBigInt(tokenAAmount)) {
        logger.warn(
            `[pool-validation] Insufficient balance for ${tokenASymbol}. Required: ${tokenAAmount}, Available: ${tokenABalance}`
        );
        return false;
    }

    if (tokenBBalance < toBigInt(tokenBAmount)) {
        logger.warn(
            `[pool-validation] Insufficient balance for ${tokenBSymbol}. Required: ${tokenBAmount}, Available: ${tokenBBalance}`
        );
        return false;
    }

    return true;
};

/**
 * Validates pool ratio tolerance for subsequent liquidity additions
 * @param pool Pool data
 * @param tokenAAmount Token A amount to add
 * @param tokenBAmount Token B amount to add
 * @returns True if ratio is within tolerance, false otherwise
 */
export const validatePoolRatioTolerance = (
    pool: LiquidityPoolData,
    tokenAAmount: string | bigint,
    tokenBAmount: string | bigint
): boolean => {
    // For initial liquidity provision, both token amounts must be positive
    if (toBigInt(pool.totalLpTokens) === toBigInt(0)) {
        if (toBigInt(tokenAAmount) <= toBigInt(0) || toBigInt(tokenBAmount) <= toBigInt(0)) {
            logger.warn('[pool-validation] Initial liquidity provision requires positive amounts for both tokens.');
            return false;
        }
        return true;
    }

    // For subsequent provisions, check if amounts maintain the pool ratio within tolerance
    const expectedTokenBAmount = (toBigInt(tokenAAmount) * toBigInt(pool.tokenB_reserve)) / toBigInt(pool.tokenA_reserve);
    const tolerance = toBigInt(100); // 1% tolerance as basis points (100 = 1%)
    const actualB = toBigInt(tokenBAmount);
    const difference = actualB > expectedTokenBAmount ? actualB - expectedTokenBAmount : expectedTokenBAmount - actualB;
    const maxDifference = (expectedTokenBAmount * tolerance) / toBigInt(10000);

    if (difference > maxDifference) {
        logger.warn(
            `[pool-validation] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount}, Got: ${tokenBAmount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${tokenAAmount}`
        );
        return false;
    }

    return true;
};

/**
 * Validates that a pool exists
 * @param poolId Pool identifier
 * @returns Pool data if exists, null otherwise
 */
export const poolExists = async (poolId: string): Promise<LiquidityPoolData | null> => {
    const poolDB = (await cache.findOnePromise('liquidityPools', { _id: poolId })) as LiquidityPoolData | null;
    if (!poolDB) {
        logger.warn(`[pool-validation] Pool with ID ${poolId} does not exist.`);
        return null;
    }
    return poolDB;
};

/**
 * Validates initial and subsequent liquidity provision amounts for a pool
 */
export const validateLiquidityProvision = (pool: LiquidityPoolData, tokenAAmount: string, tokenBAmount: string): boolean => {
    if (toBigInt(pool.totalLpTokens) === toBigInt(0)) {
        if (toBigInt(tokenAAmount) <= toBigInt(0) || toBigInt(tokenBAmount) <= toBigInt(0)) {
            logger.warn('[pool-validation] Initial liquidity provision requires positive amounts for both tokens.');
            return false;
        }
        return true;
    }

    // For subsequent provisions, check if amounts maintain the pool ratio within tolerance
    const expectedTokenBAmount = (toBigInt(tokenAAmount) * toBigInt(pool.tokenB_reserve)) / toBigInt(pool.tokenA_reserve);
    const tolerance = toBigInt(100); // 1% tolerance as basis points (100 = 1%)
    const actualB = toBigInt(tokenBAmount);
    const difference = actualB > expectedTokenBAmount ? actualB - expectedTokenBAmount : expectedTokenBAmount - actualB;
    const maxDifference = (expectedTokenBAmount * tolerance) / toBigInt(10000);

    if (difference > maxDifference) {
        logger.warn(
            `[pool-validation] Token amounts do not match current pool ratio. Expected B: ${expectedTokenBAmount}, Got: ${tokenBAmount}. Pool A reserve: ${pool.tokenA_reserve}, B reserve: ${pool.tokenB_reserve}, A amount: ${tokenAAmount}`
        );
        return false;
    }

    return true;
};

/**
 * Validates that the LP token exists for a pool
 */
export const validateLpTokenExists = async (tokenASymbol: string, tokenBSymbol: string, poolId: string): Promise<boolean> => {
    const lpTokenSymbol = getLpTokenSymbol(tokenASymbol, tokenBSymbol);
    const existingLpToken = await cache.findOnePromise('tokens', { _id: lpTokenSymbol });
    if (!existingLpToken) {
        logger.warn(
            `[pool-validation] LP token ${lpTokenSymbol} does not exist for pool ${poolId}. This suggests the pool was created before the LP token creation was fixed. Please contact support or recreate the pool.`
        );
        return false;
    }
    return true;
};
