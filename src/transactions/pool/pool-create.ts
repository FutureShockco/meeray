import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { PoolCreateData, LiquidityPoolData } from './pool-interfaces.js';
import config from '../../config.js';
import { convertToBigInt } from '../../utils/bigint.js';
import { getLpTokenSymbol } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS_POOL_CREATE: Array<keyof PoolCreateData> = [];

function generatePoolId(tokenA_symbol: string, tokenB_symbol: string): string {
  // Ensure canonical order to prevent duplicate pools (e.g., A-B vs B-A)
  const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
  return `${token1}_${token2}`;
}

function generateLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string): string {
  // Make LP token symbols shorter and more predictable
  const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
  return `LP_${token1}_${token2}`;
}

export async function validateTx(data: PoolCreateData, sender: string): Promise<boolean> {
  try {
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

    // Fee is fixed at 0.3% (300 basis points) - no configuration needed

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
    const poolId = generatePoolId(data.tokenA_symbol, data.tokenB_symbol);
    const existingPool = await cache.findOnePromise('liquidityPools', { _id: poolId });
    if (existingPool) {
      logger.warn(`[pool-create] Liquidity pool with ID ${poolId} already exists.`);
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

export async function process(data: PoolCreateData, sender: string, id: string): Promise<boolean> {
  try {
    // Fee is fixed at 0.3% (300 basis points) - no configuration needed
    const createData = convertToBigInt<PoolCreateData>(data, NUMERIC_FIELDS_POOL_CREATE);

    const poolId = generatePoolId(createData.tokenA_symbol, createData.tokenB_symbol);
    const lpTokenSymbol = generateLpTokenSymbol(createData.tokenA_symbol, createData.tokenB_symbol);

    let tokenA_symbol = createData.tokenA_symbol;
    let tokenB_symbol = createData.tokenB_symbol;

    // Canonical ordering of tokens by symbol
    if (tokenA_symbol > tokenB_symbol) {
      [tokenA_symbol, tokenB_symbol] = [tokenB_symbol, tokenA_symbol];
    }

    const poolDocumentApp: LiquidityPoolData = {
      _id: poolId,
      tokenA_symbol: tokenA_symbol,
      tokenA_reserve: toDbString(BigInt(0)),
      tokenB_symbol: tokenB_symbol,
      tokenB_reserve: toDbString(BigInt(0)),
      totalLpTokens: toDbString(BigInt(0)),
      createdAt: new Date().toISOString(),
      status: 'ACTIVE'
    };
    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('liquidityPools', poolDocumentApp, (err, result) => {
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
    logger.debug(`[pool-create] Liquidity Pool ${poolId} (${tokenA_symbol}-${tokenB_symbol}, Fee: 0.3%) created by ${sender}. LP Token: ${lpTokenSymbol}`);
    const tokenSymbol = getLpTokenSymbol(tokenA_symbol, tokenB_symbol);
    // Create LP token for this pool if it does not exist
    const existingLpToken = await cache.findOnePromise('tokens', { _id: tokenSymbol });
    if (!existingLpToken) {
      const lpToken = {
        _id: tokenSymbol,
        symbol: tokenSymbol,
        name: `LP Token for ${tokenA_symbol}-${tokenB_symbol}`,
        issuer: 'null',
        precision: 18,
        maxSupply: toDbString(BigInt(1000000000000000000)), // Large max supply
        currentSupply: toDbString(BigInt(0)),
        mintable: false,
        burnable: false,
        description: `Liquidity provider token for pool ${poolId}`,
        createdAt: new Date().toISOString()
      };
      await new Promise((resolve) => {
        cache.insertOne('tokens', lpToken, (err, result) => {
          if (err || !result) {
            logger.error(`[pool-create] Failed to create LP token ${lpTokenSymbol}: ${err}`);
            resolve(false);
          } else {
            logger.info(`[pool-create] Created LP token ${lpTokenSymbol} for pool ${poolId}`);
            resolve(true);
          }
        });
      });
    }

    // Log event using the new centralized logger
        await logEvent('defi', 'pool_created', sender, {
          poolId,
          tokenA: tokenA_symbol,
          tokenB: tokenB_symbol,
          initialLiquidity: {
            tokenAAmount: '0',
            tokenBAmount: '0'
          }
        }, id);

    // Automatically create trading pair for this pool
    try {
      // Generate trading pair ID (same format as market system)
      const pairId = `${tokenA_symbol}-${tokenB_symbol}`;
      
      const maxTradeAmount = BigInt(1000000000000000000000000000000); // 1,000,000,000 (adjustable based on token value)
      
      // Create trading pair document
      const tradingPairDB = {
        _id: pairId,
        baseAssetSymbol: tokenA_symbol,
        quoteAssetSymbol: tokenB_symbol,
        tickSize: toDbString(1),
        lotSize: toDbString(1),
        minNotional: toDbString(1),
        status: 'TRADING',
        minTradeAmount: toDbString(1),
        maxTradeAmount: toDbString(maxTradeAmount),
        createdAt: new Date().toISOString()
      };

      // Insert trading pair into database
      const pairInsertSuccess = await new Promise<boolean>((resolve) => {
        cache.insertOne('tradingPairs', tradingPairDB, (err, result) => {
          if (err || !result) {
            logger.warn(`[pool-create] Failed to create trading pair ${pairId}: ${err}`);
            resolve(false);
          } else {
            logger.info(`[pool-create] Created trading pair ${pairId} for pool ${poolId}`);
            resolve(true);
          }
        });
      });

      if (pairInsertSuccess) {
        // Log trading pair creation event
        await logEvent('market', 'pair_created', sender, {
          pairId,
          baseAssetSymbol: tokenA_symbol,
          quoteAssetSymbol: tokenB_symbol,
          tickSize: toDbString(1),
          lotSize: toDbString(1),
          minNotional: toDbString(1),
          minTradeAmount: toDbString(1),
          maxTradeAmount: toDbString(maxTradeAmount),
          initialStatus: 'TRADING',
          createdAt: new Date().toISOString(),
          autoCreated: true,
          poolId: poolId
        });
      }
    } catch (error) {
      // Log warning but don't fail pool creation
      logger.warn(`[pool-create] Failed to create trading pair for pool ${poolId}: ${error}`);
    }

    return true;
  } catch (error) {
    logger.error(`[pool-create] Error processing pool creation by ${sender}: ${error}`);
    return false;
  }
} 