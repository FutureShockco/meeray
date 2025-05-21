import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolCreateData, LiquidityPool } from './pool-interfaces.js';
import { generateDeterministicId } from '../../utils/id-utils.js';

const ALLOWED_FEE_TIERS = [5, 30, 100, 500]; // 0.05%, 0.3%, 1%, 5% (example)
const DEFAULT_FEE_TIER = 30; // 0.3%

// Helper function to generate a unique and deterministic pool ID
function generatePoolId(tokenA_symbol: string, tokenA_issuer: string, tokenB_symbol: string, tokenB_issuer: string, feeTier: number): string {
  const component1 = `${tokenA_symbol}@${tokenA_issuer}`;
  const component2 = `${tokenB_symbol}@${tokenB_issuer}`;
  const component3 = `FEE${feeTier.toString()}`;
  return generateDeterministicId(component1, component2, component3);
}

// Helper function to generate LP token symbol
function generateLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string, feeTier: number): string {
  // Using only symbols for LP token, and fee tier, consistent with previous LP_TOKENA_TOKENB_FEE format but now sorted
  const component1 = tokenA_symbol;
  const component2 = tokenB_symbol;
  const component3 = `FEE${feeTier.toString()}`;
  return `LP_${generateDeterministicId(component1, component2, component3)}`;
}

export async function validateTx(data: PoolCreateData, sender: string): Promise<boolean> {
  try {
    if (!data.tokenA_symbol || !data.tokenA_issuer || !data.tokenB_symbol || !data.tokenB_issuer) {
      logger.warn('[pool-create] Invalid data: Missing required token symbols or issuers.');
      return false;
    }

    // Validate token symbols (e.g., 3-10 uppercase letters - adjust as per your token spec)
    if (!validate.string(data.tokenA_symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[pool-create] Invalid tokenA_symbol: ${data.tokenA_symbol}.`);
      return false;
    }
    if (!validate.string(data.tokenB_symbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
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

    let chosenFeeTier = data.feeTier;
    if (chosenFeeTier === undefined) {
      chosenFeeTier = DEFAULT_FEE_TIER;
      logger.debug(`[pool-create] No feeTier provided, using default: ${chosenFeeTier} bps.`);
    } else {
      if (!validate.integer(chosenFeeTier) || !ALLOWED_FEE_TIERS.includes(chosenFeeTier)) {
        logger.warn(`[pool-create] Invalid feeTier: ${chosenFeeTier}. Allowed tiers: ${ALLOWED_FEE_TIERS.join(', ')}.`);
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
      logger.warn(`[pool-create] Liquidity pool with ID ${poolId} (tokens + fee tier ${chosenFeeTier}) already exists.`);
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

export async function process(data: PoolCreateData, sender: string): Promise<boolean> {
  try {
    const chosenFeeTier = data.feeTier === undefined ? DEFAULT_FEE_TIER : data.feeTier; // Validation ensures it's allowed or default
    const feeRate = chosenFeeTier / 10000; // Convert basis points to rate (e.g., 30bps -> 0.003)

    const poolId = generatePoolId(data.tokenA_symbol, data.tokenA_issuer, data.tokenB_symbol, data.tokenB_issuer, chosenFeeTier);
    const lpTokenSymbol = generateLpTokenSymbol(data.tokenA_symbol, data.tokenB_symbol, chosenFeeTier);

    // Ensure tokens are stored in a consistent order (e.g., alphabetically by symbol@issuer)
    let tokenA_details = { symbol: data.tokenA_symbol, issuer: data.tokenA_issuer };
    let tokenB_details = { symbol: data.tokenB_symbol, issuer: data.tokenB_issuer };

    if (`${tokenA_details.symbol}@${tokenA_details.issuer}` > `${tokenB_details.symbol}@${tokenB_details.issuer}`) {
        [tokenA_details, tokenB_details] = [tokenB_details, tokenA_details]; // Swap to ensure consistent ordering
    }

    const poolDocument: LiquidityPool = {
      _id: poolId,
      tokenA_symbol: tokenA_details.symbol,
      tokenA_issuer: tokenA_details.issuer,
      tokenA_reserve: 0,
      tokenB_symbol: tokenB_details.symbol,
      tokenB_issuer: tokenB_details.issuer,
      tokenB_reserve: 0,
      totalLpTokens: 0,
      lpTokenSymbol: lpTokenSymbol,
      feeRate: feeRate, // Store the calculated fee rate
      createdAt: new Date().toISOString(),
    };


    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('liquidityPools', poolDocument, (err, result) => {
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
    logger.debug(`[pool-create] Liquidity Pool ${poolId} (${tokenA_details.symbol}-${tokenB_details.symbol}, Fee: ${chosenFeeTier}bps) created by ${sender}.`);

    // Log event
    const eventDocument = {
      type: 'poolCreate',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { ...poolDocument }
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