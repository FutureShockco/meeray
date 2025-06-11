import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolCreateData, LiquidityPool, PoolCreateDataDB, LiquidityPoolDB } from './pool-interfaces.js';
import { generateDeterministicId } from '../../utils/id-utils.js';
import config from '../../config.js';
import { BigIntMath, convertToBigInt, convertToString, toString, toBigInt } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const ALLOWED_FEE_TIERS: bigint[] = [BigInt(5), BigInt(30), BigInt(100), BigInt(500)];
const DEFAULT_FEE_TIER: bigint = BigInt(30);
const NUMERIC_FIELDS_POOL_CREATE: Array<keyof PoolCreateData> = ['feeTier'];
const LIQUIDITY_POOL_NUMERIC_FIELDS: Array<keyof LiquidityPool> = ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier'];

function generatePoolId(tokenA_symbol: string, tokenB_symbol: string, feeTier: bigint): string {
  const component1 = tokenA_symbol;
  const component2 = tokenB_symbol;
  const component3 = `FEE${toString(feeTier)}`;
  // Ensure canonical order to prevent duplicate pools (e.g., A-B vs B-A)
  const sortedComponents = [component1, component2].sort();
  return generateDeterministicId(sortedComponents[0], sortedComponents[1], component3);
}

function generateLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string, feeTier: bigint): string {
  const component1 = tokenA_symbol;
  const component2 = tokenB_symbol;
  const component3 = `FEE${toString(feeTier)}`;
  // Make LP token symbols shorter and more predictable if possible
  const pairPart = `${tokenA_symbol.substring(0,3)}${tokenB_symbol.substring(0,3)}`.toUpperCase();
  return `LP_${pairPart}_${toString(feeTier)}`; 
}

export async function validateTx(dataDb: PoolCreateDataDB, sender: string): Promise<boolean> {
  try {
    const data = convertToBigInt<PoolCreateData>(dataDb, NUMERIC_FIELDS_POOL_CREATE);
    if (!data.tokenA_symbol || !data.tokenB_symbol) {
      logger.warn('[pool-create] Invalid data: Missing required token symbols.');
      return false;
    }

    // Validate token symbols (e.g., 3-10 uppercase letters - adjust as per your token spec)
    if (!validate.string(data.tokenA_symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[pool-create] Invalid tokenA_symbol: ${data.tokenA_symbol}.`);
      return false;
    }
    if (!validate.string(data.tokenB_symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[pool-create] Invalid tokenB_symbol: ${data.tokenB_symbol}.`);
      return false;
    }

    // Prevent creating a pool with the same token on both sides
    if (data.tokenA_symbol === data.tokenB_symbol) {
      logger.warn('[pool-create] Cannot create a pool with the same token on both sides.');
      return false;
    }

    let chosenFeeTier: bigint;
    if (data.feeTier === undefined) {
      chosenFeeTier = DEFAULT_FEE_TIER;
      logger.debug(`[pool-create] No feeTier provided, using default: ${toString(chosenFeeTier)} bps.`);
    } else {
      chosenFeeTier = data.feeTier; // Already BigInt due to convertToBigInt
      // Validate.integer cannot be directly used for BigInt. Check if it's a whole number if needed by other means or trust input.
      // For inclusion, convert chosenFeeTier to number for ALLOWED_FEE_TIERS.includes, or check BigInt equality.
      if (!ALLOWED_FEE_TIERS.some(tier => tier === chosenFeeTier)) {
        logger.warn(`[pool-create] Invalid feeTier: ${toString(chosenFeeTier)}. Allowed tiers: ${ALLOWED_FEE_TIERS.map(t => toString(t)).join(', ')}.`);
        return false;
      }
    }

    // Check if tokens exist
    const tokenAExists = await cache.findOnePromise('tokens', { _id: data.tokenA_symbol });
    if (!tokenAExists) {
      logger.warn(`[pool-create] Token A (${data.tokenA_symbol}) not found.`);
      return false;
    }
    const tokenBExists = await cache.findOnePromise('tokens', { _id: data.tokenB_symbol });
    if (!tokenBExists) {
      logger.warn(`[pool-create] Token B (${data.tokenB_symbol}) not found.`);
      return false;
    }

    // Check for pool uniqueness
    const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol, chosenFeeTier);
    const existingPool = await cache.findOnePromise('liquidityPools', { _id: poolId });
    if (existingPool) {
      logger.warn(`[pool-create] Liquidity pool with ID ${poolId} (tokens + fee tier ${toString(chosenFeeTier)}) already exists.`);
      return false;
    }

    // Validate sender account exists (creator)
    const creatorAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!creatorAccount) {
      logger.warn(`[pool-create] Creator account ${sender} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[pool-create] Error validating data for pool by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: PoolCreateDataDB, sender: string, id: string): Promise<boolean> {
    try {
        const createData = convertToBigInt<PoolCreateData>(data, NUMERIC_FIELDS_POOL_CREATE);
        let chosenFeeTier = createData.feeTier;
        if (chosenFeeTier === undefined) {
            chosenFeeTier = DEFAULT_FEE_TIER;
        }
        // feeRate calculation removed as it's not stored in LiquidityPool interface

        const poolId = generatePoolId(createData.tokenA_symbol, createData.tokenB_symbol, chosenFeeTier);
        const lpTokenSymbol = generateLpTokenSymbol(createData.tokenA_symbol, createData.tokenB_symbol, chosenFeeTier);

        let tokenA_symbol = createData.tokenA_symbol;
        let tokenB_symbol = createData.tokenB_symbol;
        
        // Canonical ordering of tokens by symbol
        if (tokenA_symbol > tokenB_symbol) {
            [tokenA_symbol, tokenB_symbol] = [tokenB_symbol, tokenA_symbol];
        }

        const poolDocumentApp: LiquidityPool = {
            _id: poolId,
            tokenA_symbol: tokenA_symbol,
            tokenA_reserve: BigInt(0),
            tokenB_symbol: tokenB_symbol,
            tokenB_reserve: BigInt(0),
            totalLpTokens: BigInt(0),
            feeTier: chosenFeeTier, 
            createdAt: new Date().toISOString(),
            status: 'ACTIVE'
        };

        const poolDocumentDB = convertToString<LiquidityPool>(poolDocumentApp, LIQUIDITY_POOL_NUMERIC_FIELDS);

        const createSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('liquidityPools', poolDocumentDB, (err, result) => {
                if (err || !result) {
                    logger.error(`[pool-create] Failed to insert pool ${poolId} into cache: ${err || 'no result'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });

        if (!createSuccess) {
            return false;
        }
        logger.debug(`[pool-create] Liquidity Pool ${poolId} (${tokenA_symbol}-${tokenB_symbol}, Fee: ${toString(chosenFeeTier)}bps) created by ${sender}. LP Token: ${lpTokenSymbol}`);

        // Log event using the new centralized logger
        const eventData = { ...poolDocumentDB, lpTokenSymbol: lpTokenSymbol };
        await logTransactionEvent('poolCreate', sender, eventData, id);

        return true;
    } catch (error) {
        logger.error(`[pool-create] Error processing pool creation by ${sender}: ${error}`);
        return false;
    }
} 