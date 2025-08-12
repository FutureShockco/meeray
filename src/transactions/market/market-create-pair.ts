import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { MarketCreatePairData, TradingPairData } from './market-interfaces.js';
import { getAccount } from '../../utils/account.js';
import { convertToBigInt, toDbString, toBigInt } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import config from '../../config.js';

const NUMERIC_FIELDS: Array<keyof MarketCreatePairData> = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];

/**
 * Generate a unique trading pair ID from base and quote assets
 */
function generatePairId(baseSymbol: string, baseIssuer: string, quoteSymbol: string, quoteIssuer: string): string {
    return `${baseSymbol}@${baseIssuer}-${quoteSymbol}@${quoteIssuer}`;
}

/**
 * Validate if a token exists and is properly formatted
 */
async function validateTokenExists(symbol: string, issuer: string): Promise<boolean> {
    // For native tokens (ECH, STEEM, SBD), check if issuer matches master name
    const nativeTokens = [config.nativeTokenSymbol, 'STEEM', 'SBD'];
    if (nativeTokens.includes(symbol)) {
        if (issuer !== config.masterName) {
            logger.warn(`[market-create-pair] Native token ${symbol} must have issuer as ${config.masterName}, got ${issuer}`);
            return false;
        }
        return true;
    }

    // For custom tokens, check if token exists in database
    const token = await cache.findOnePromise('tokens', { _id: symbol });
    if (!token) {
        logger.warn(`[market-create-pair] Token ${symbol} not found`);
        return false;
    }

    // Verify the issuer matches the token's issuer
    if (token.issuer !== issuer) {
        logger.warn(`[market-create-pair] Token ${symbol} issuer mismatch. Expected: ${token.issuer}, got: ${issuer}`);
        return false;
    }

    return true;
}

export async function validateTx(data: MarketCreatePairData, sender: string): Promise<boolean> {
    try {
        logger.debug(`[market-create-pair] Validating pair creation from ${sender}`);

        // Convert numeric fields to BigInt
        const pairData = convertToBigInt<MarketCreatePairData>(data, NUMERIC_FIELDS);

        // Validate required fields
        if (!pairData.baseAssetSymbol || !pairData.quoteAssetSymbol) {
            logger.warn('[market-create-pair] Missing required fields: baseAssetSymbol, quoteAssetSymbol');
            return false;
        }

        // Validate symbol formats
        if (!validate.string(pairData.baseAssetSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[market-create-pair] Invalid baseAssetSymbol format: ${pairData.baseAssetSymbol}`);
            return false;
        }

        if (!validate.string(pairData.quoteAssetSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[market-create-pair] Invalid quoteAssetSymbol format: ${pairData.quoteAssetSymbol}`);
            return false;
        }

        // Prevent creating pairs with the same token
        if (pairData.baseAssetSymbol === pairData.quoteAssetSymbol) {
            logger.warn('[market-create-pair] Cannot create a trading pair with the same token on both sides');
            return false;
        }

        // SECURITY FIX: Use sender as issuer instead of user-provided values
        // This prevents users from specifying arbitrary issuers
        const baseIssuer = sender;
        const quoteIssuer = sender;

        // Validate that tokens exist and sender has permission to create pairs with them
        const baseTokenValid = await validateTokenExists(pairData.baseAssetSymbol, baseIssuer);
        if (!baseTokenValid) {
            return false;
        }

        const quoteTokenValid = await validateTokenExists(pairData.quoteAssetSymbol, quoteIssuer);
        if (!quoteTokenValid) {
            return false;
        }

        // Validate numeric parameters
        if (!validate.bigint(pairData.tickSize, false, false, undefined, BigInt(1))) {
            logger.warn('[market-create-pair] tickSize must be a positive integer');
            return false;
        }

        if (!validate.bigint(pairData.lotSize, false, false, undefined, BigInt(1))) {
            logger.warn('[market-create-pair] lotSize must be a positive integer');
            return false;
        }

        if (!validate.bigint(pairData.minNotional, false, false, undefined, BigInt(1))) {
            logger.warn('[market-create-pair] minNotional must be a positive integer');
            return false;
        }

        if (pairData.minTradeAmount !== undefined && !validate.bigint(pairData.minTradeAmount, true, false, undefined, BigInt(0))) {
            logger.warn('[market-create-pair] minTradeAmount must be non-negative if provided');
            return false;
        }

        if (pairData.maxTradeAmount !== undefined && !validate.bigint(pairData.maxTradeAmount, false, false, undefined, BigInt(1))) {
            logger.warn('[market-create-pair] maxTradeAmount must be positive if provided');
            return false;
        }

        // Validate initial status if provided
        if (pairData.initialStatus && !['TRADING', 'PRE_TRADE', 'HALTED'].includes(pairData.initialStatus)) {
            logger.warn(`[market-create-pair] Invalid initialStatus: ${pairData.initialStatus}`);
            return false;
        }

        // Check if pair already exists
        const pairId = generatePairId(pairData.baseAssetSymbol, baseIssuer, pairData.quoteAssetSymbol, quoteIssuer);
        const existingPair = await cache.findOnePromise('tradingPairs', { _id: pairId });
        if (existingPair) {
            logger.warn(`[market-create-pair] Trading pair ${pairId} already exists`);
            return false;
        }

        // Validate sender account exists
        const senderAccount = await getAccount(sender);
        if (!senderAccount) {
            logger.warn(`[market-create-pair] Sender account ${sender} not found`);
            return false;
        }

        logger.debug(`[market-create-pair] Validation successful for pair ${pairId}`);
        return true;

    } catch (error) {
        logger.error(`[market-create-pair] Error validating pair creation: ${error}`);
        return false;
    }
}

export async function process(data: MarketCreatePairData, sender: string, id: string): Promise<boolean> {
    try {
        logger.debug(`[market-create-pair] Processing pair creation from ${sender}`);

        // Convert numeric fields to BigInt
        const pairData = convertToBigInt<MarketCreatePairData>(data, NUMERIC_FIELDS);

        // SECURITY: Use sender as issuer (same as in validation)
        const baseIssuer = sender;
        const quoteIssuer = sender;

        // Generate pair ID
        const pairId = generatePairId(pairData.baseAssetSymbol, baseIssuer, pairData.quoteAssetSymbol, quoteIssuer);

        // Create trading pair object for application layer (with BigInt)
        const tradingPairApp: TradingPairData = {
            _id: pairId,
            baseAssetSymbol: pairData.baseAssetSymbol,
            baseAssetIssuer: baseIssuer, // Use sender as issuer
            quoteAssetSymbol: pairData.quoteAssetSymbol,
            quoteAssetIssuer: quoteIssuer, // Use sender as issuer
            tickSize: toBigInt(pairData.tickSize),
            lotSize: toBigInt(pairData.lotSize),
            minNotional: toBigInt(pairData.minNotional),
            status: pairData.initialStatus || 'TRADING',
            minTradeAmount: pairData.minTradeAmount ? toBigInt(pairData.minTradeAmount) : BigInt(0),
            maxTradeAmount: pairData.maxTradeAmount ? toBigInt(pairData.maxTradeAmount) : BigInt(0),
            createdAt: new Date().toISOString()
        };

        // Convert to database format (with strings)
        const tradingPairDB = {
            _id: pairId,
            baseAssetSymbol: pairData.baseAssetSymbol,
            baseAssetIssuer: baseIssuer,
            quoteAssetSymbol: pairData.quoteAssetSymbol,
            quoteAssetIssuer: quoteIssuer,
            tickSize: toDbString(toBigInt(tradingPairApp.tickSize)),
            lotSize: toDbString(toBigInt(tradingPairApp.lotSize)),
            minNotional: toDbString(toBigInt(tradingPairApp.minNotional)),
            status: tradingPairApp.status,
            minTradeAmount: toDbString(toBigInt(tradingPairApp.minTradeAmount || 0)),
            maxTradeAmount: toDbString(toBigInt(tradingPairApp.maxTradeAmount || 0)),
            createdAt: tradingPairApp.createdAt
        };

        // Insert trading pair into database
        const insertSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('tradingPairs', tradingPairDB, (err, result) => {
                if (err || !result) {
                    logger.error(`[market-create-pair] Failed to insert trading pair ${pairId}: ${err || 'no result'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });

        if (!insertSuccess) {
            return false;
        }

        // Log the event
        await logTransactionEvent(id, 'market_create_pair', {
            pairId,
            baseAsset: `${pairData.baseAssetSymbol}@${baseIssuer}`,
            quoteAsset: `${pairData.quoteAssetSymbol}@${quoteIssuer}`,
            creator: sender
        });

        logger.info(`[market-create-pair] Successfully created trading pair ${pairId} by ${sender}`);
        return true;

    } catch (error) {
        logger.error(`[market-create-pair] Error processing pair creation: ${error}`);
        return false;
    }
}
