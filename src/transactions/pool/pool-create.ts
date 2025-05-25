import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolCreateData, LiquidityPool, PoolCreateDataDB, LiquidityPoolDB } from './pool-interfaces.js';
import { generateDeterministicId } from '../../utils/id-utils.js';
import config from '../../config.js';
import { BigIntMath, convertToBigInt, convertToString, toString, toBigInt } from '../../utils/bigint-utils.js';

const ALLOWED_FEE_TIERS: bigint[] = [BigInt(5), BigInt(30), BigInt(100), BigInt(500)];
const DEFAULT_FEE_TIER: bigint = BigInt(30);
const NUMERIC_FIELDS_POOL_CREATE: Array<keyof PoolCreateData> = ['feeTier'];
const LIQUIDITY_POOL_NUMERIC_FIELDS: Array<keyof LiquidityPool> = ['tokenA_reserve', 'tokenB_reserve', 'totalLpTokens', 'feeTier'];

function generatePoolId(tokenA_symbol: string, tokenA_issuer: string, tokenB_symbol: string, tokenB_issuer: string, feeTier: bigint): string {
  const component1 = `${tokenA_symbol}@${tokenA_issuer}`;
  const component2 = `${tokenB_symbol}@${tokenB_issuer}`;
  const component3 = `FEE${toString(feeTier)}`;
  return generateDeterministicId(component1, component2, component3);
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
    if (!data.tokenA_symbol || !data.tokenA_issuer || !data.tokenB_symbol || !data.tokenB_issuer) {
      logger.warn('[pool-create] Invalid data: Missing required token symbols or issuers.');
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

    // Validate token issuers (e.g., account name format)
    if (!validate.string(data.tokenA_issuer, 16, 3)) { // Assuming issuer is an account name
      logger.warn(`[pool-create] Invalid tokenA_issuer: ${data.tokenA_issuer}.`);
      return false;
    }
    if (!validate.string(data.tokenB_issuer, 16, 3)) {
      logger.warn(`[pool-create] Invalid tokenB_issuer: ${data.tokenB_issuer}.`);
      return false;
    }

    // Prevent creating a pool with the same token on both sides
    if (data.tokenA_symbol === data.tokenB_symbol && data.tokenA_issuer === data.tokenB_issuer) {
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

    // Check if tokens exist (by symbol and issuer)
    // This assumes you have a 'tokens' collection where tokens are registered
    const tokenAExists = await cache.findOnePromise('tokens', { symbol: data.tokenA_symbol, issuer: data.tokenA_issuer });
    if (!tokenAExists) {
      logger.warn(`[pool-create] Token A (${data.tokenA_symbol}@${data.tokenA_issuer}) not found.`);
      return false;
    }
    const tokenBExists = await cache.findOnePromise('tokens', { symbol: data.tokenB_symbol, issuer: data.tokenB_issuer });
    if (!tokenBExists) {
      logger.warn(`[pool-create] Token B (${data.tokenB_symbol}@${data.tokenB_issuer}) not found.`);
      return false;
    }

    // Check for pool uniqueness
    const poolId = generatePoolId(data.tokenA_symbol, data.tokenA_issuer, data.tokenB_symbol, data.tokenB_issuer, chosenFeeTier);
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

export async function process(dataDb: PoolCreateDataDB, sender: string): Promise<boolean> {
  try {
    const data = convertToBigInt<PoolCreateData>(dataDb, NUMERIC_FIELDS_POOL_CREATE);
    let chosenFeeTier = data.feeTier;
    if (chosenFeeTier === undefined) {
        chosenFeeTier = DEFAULT_FEE_TIER;
    }
    // feeRate calculation removed as it's not stored in LiquidityPool interface

    const poolId = generatePoolId(data.tokenA_symbol, data.tokenA_issuer, data.tokenB_symbol, data.tokenB_issuer, chosenFeeTier);
    const lpTokenSymbol = generateLpTokenSymbol(data.tokenA_symbol, data.tokenB_symbol, chosenFeeTier);

    let tokenA_details = { symbol: data.tokenA_symbol, issuer: data.tokenA_issuer };
    let tokenB_details = { symbol: data.tokenB_symbol, issuer: data.tokenB_issuer };
    if (`${tokenA_details.symbol}@${tokenA_details.issuer}` > `${tokenB_details.symbol}@${tokenB_details.issuer}`) {
        [tokenA_details, tokenB_details] = [tokenB_details, tokenA_details];
    }

    const poolDocumentApp: LiquidityPool = {
      _id: poolId,
      tokenA_symbol: tokenA_details.symbol,
      tokenA_issuer: tokenA_details.issuer,
      tokenA_reserve: BigInt(0),
      tokenB_symbol: tokenB_details.symbol,
      tokenB_issuer: tokenB_details.issuer,
      tokenB_reserve: BigInt(0),
      totalLpTokens: BigInt(0),
      // lpTokenSymbol: lpTokenSymbol, // LiquidityPool interface does not have lpTokenSymbol
      feeTier: chosenFeeTier, // This is BigInt
      createdAt: new Date().toISOString(),
      status: 'ACTIVE' // Default status
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
    logger.debug(`[pool-create] Liquidity Pool ${poolId} (${tokenA_details.symbol}-${tokenB_details.symbol}, Fee: ${toString(chosenFeeTier)}bps) created by ${sender}. LP Token: ${lpTokenSymbol}`);

    // TODO: Create the LP token itself using token-create transaction? Or is it virtual?
    // For now, assume LP token symbol is just for reference in the pool doc.

    const eventDocument = {
      type: 'poolCreate',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { ...poolDocumentDB, lpTokenSymbol: lpTokenSymbol } // Include lpTokenSymbol in event data for reference
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[pool-create] CRITICAL: Failed to log poolCreate event for ${poolId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[pool-create] Error processing pool creation by ${sender}: ${error}`);
    return false;
  }
} 