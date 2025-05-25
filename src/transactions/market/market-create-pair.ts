import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCreatePairData, MarketCreatePairDataDB, TradingPair, TradingPairDB } from './market-interfaces.js';
// import crypto from 'crypto'; // No longer needed for TradingPairId generation
import { generateDeterministicId } from '../../utils/id-utils.js'; // Import the new helper
import { convertToBigInt, convertToString } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js'; // Import the new event logger

const NUMERIC_FIELDS_CREATE_PAIR: Array<keyof MarketCreatePairData> = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];

// Function to generate a unique ID for the trading pair
function generateTradingPairId(baseAssetSymbol: string, baseAssetIssuer: string, quoteAssetSymbol: string, quoteAssetIssuer: string): string {
  const component1 = `${baseAssetSymbol}@${baseAssetIssuer}`;
  const component2 = `${quoteAssetSymbol}@${quoteAssetIssuer}`;
  // No fee tier or other distinguishing component needed here as pairs are unique by their two assets.
  return generateDeterministicId(component1, component2);
}

export async function validateTx(dataDb: MarketCreatePairDataDB, sender: string): Promise<boolean> {
  const data = convertToBigInt<MarketCreatePairData>(dataDb, NUMERIC_FIELDS_CREATE_PAIR);
  logger.debug(`[market-create-pair] Validating data for sender: ${sender}, data: ${JSON.stringify(data)}`);
  // Basic validation
  if (!data.baseAssetSymbol || !data.baseAssetIssuer || !data.quoteAssetSymbol || !data.quoteAssetIssuer) {
    logger.warn('[market-create-pair] Missing asset symbol or issuer.');
    return false;
  }
  // Validate BigInt fields
  if (data.tickSize <= BigInt(0)) {
    logger.warn('[market-create-pair] Invalid tickSize.');
    return false;
  }
  if (data.lotSize <= BigInt(0)) {
    logger.warn('[market-create-pair] Invalid lotSize.');
    return false;
  }
  if (data.minNotional < BigInt(0)) {
    logger.warn('[market-create-pair] Invalid minNotional.');
    return false;
  }
  if (data.minTradeAmount && data.minTradeAmount < BigInt(0)) {
    logger.warn('[market-create-pair] Invalid minTradeAmount.');
    return false;
  }
  if (data.maxTradeAmount && data.maxTradeAmount < BigInt(0)) {
    logger.warn('[market-create-pair] Invalid maxTradeAmount.');
    return false;
  }
  if (data.minTradeAmount && data.maxTradeAmount && data.minTradeAmount > data.maxTradeAmount) {
    logger.warn('[market-create-pair] minTradeAmount cannot exceed maxTradeAmount.');
    return false;
  }

  // Validate asset symbols and issuers (similar to pool creation)
  if (!validate.string(data.baseAssetSymbol, 10, 3) || !validate.string(data.quoteAssetSymbol, 10, 3)) {
      logger.warn('[market-create-pair] Invalid asset symbol format.');
      return false;
  }
  if (!validate.string(data.baseAssetIssuer, 16, 3) || !validate.string(data.quoteAssetIssuer, 16, 3)) {
      logger.warn('[market-create-pair] Invalid asset issuer format.');
      return false;
  }

  // Prevent same asset pair
  if (data.baseAssetSymbol === data.quoteAssetSymbol && data.baseAssetIssuer === data.quoteAssetIssuer) {
    logger.warn('[market-create-pair] Base and quote assets cannot be the same.');
    return false;
  }

  // Check if assets exist (assuming a 'tokens' collection)
  const baseAsset = await cache.findOnePromise('tokens', { symbol: data.baseAssetSymbol, issuer: data.baseAssetIssuer });
  if (!baseAsset) {
    logger.warn(`[market-create-pair] Base asset ${data.baseAssetSymbol}@${data.baseAssetIssuer} not found.`);
    return false;
  }
  const quoteAsset = await cache.findOnePromise('tokens', { symbol: data.quoteAssetSymbol, issuer: data.quoteAssetIssuer });
  if (!quoteAsset) {
    logger.warn(`[market-create-pair] Quote asset ${data.quoteAssetSymbol}@${data.quoteAssetIssuer} not found.`);
    return false;
  }

  // Check for pair uniqueness
  const pairId = generateTradingPairId(data.baseAssetSymbol, data.baseAssetIssuer, data.quoteAssetSymbol, data.quoteAssetIssuer);
  const existingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });
  if (existingPair) {
    logger.warn(`[market-create-pair] Trading pair with ID ${pairId} already exists.`);
    return false;
  }
  // Alternative check: ensure no other pair uses this exact base/quote combination, even if ID generation changes.
  const existingPairByAssets = await cache.findOnePromise('tradingPairs', {
    baseAssetSymbol: data.baseAssetSymbol,
    baseAssetIssuer: data.baseAssetIssuer,
    quoteAssetSymbol: data.quoteAssetSymbol,
    quoteAssetIssuer: data.quoteAssetIssuer
  });
  if (existingPairByAssets) {
    logger.warn(`[market-create-pair] Trading pair ${data.baseAssetSymbol}/${data.quoteAssetSymbol} by same issuers already exists with a different ID or configuration.`);
    return false;
  }

  const adminAccount = await cache.findOnePromise('accounts', { name: sender });
  if (!adminAccount /* || !adminAccount.isAdmin */) { // Assuming an isAdmin flag or role
    logger.warn(`[market-create-pair] Sender ${sender} is not authorized to create trading pairs.`);
    // return false;
  }

  logger.debug('[market-create-pair] Validation successful.');
  return true;
}

export async function process(transaction: { data: MarketCreatePairDataDB, sender: string, _id: string }): Promise<boolean> {
  const { data: dataDb, sender, _id: transactionId } = transaction;
  const data = convertToBigInt<MarketCreatePairData>(dataDb, NUMERIC_FIELDS_CREATE_PAIR);
  logger.debug(`[market-create-pair] Processing request from ${sender} to create pair: ${JSON.stringify(data)}`);
  try {
    const pairId = generateTradingPairId(data.baseAssetSymbol, data.baseAssetIssuer, data.quoteAssetSymbol, data.quoteAssetIssuer);

    const tradingPairDocument: TradingPair = {
      _id: pairId,
      baseAssetSymbol: data.baseAssetSymbol,
      baseAssetIssuer: data.baseAssetIssuer,
      quoteAssetSymbol: data.quoteAssetSymbol,
      quoteAssetIssuer: data.quoteAssetIssuer,
      tickSize: data.tickSize,
      lotSize: data.lotSize,
      minNotional: data.minNotional,
      minTradeAmount: data.minTradeAmount || BigInt(0),
      maxTradeAmount: data.maxTradeAmount || BigInt('1000000000000000000000'), // Default to a large number if not provided
      status: data.initialStatus || 'TRADING', // Default to TRADING if not provided
      createdAt: new Date().toISOString(),
    };

    // Convert TradingPair with BigInts to TradingPairDB with strings for storage
    const tradingPairDocumentDB = convertToString<TradingPair>(tradingPairDocument, NUMERIC_FIELDS_CREATE_PAIR as (keyof TradingPair)[]);

    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('tradingPairs', tradingPairDocumentDB, (err, result) => {
        if (err || !result) {
          logger.error(`[market-create-pair] Failed to insert trading pair ${pairId}: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!createSuccess) {
      return false;
    }

    logger.debug(`[market-create-pair] Trading Pair ${pairId} (${data.baseAssetSymbol}/${data.quoteAssetSymbol}) created by ${sender}.`);

    // Log event using the new centralized logger
    await logTransactionEvent('marketCreatePair', sender, { ...tradingPairDocumentDB }, transactionId);

    return true;
  } catch (error) {
    logger.error(`[market-create-pair] Error processing trading pair creation by ${sender}: ${error}`);
    return false;
  }
} 