import cache from '../cache.js';
import logger from '../logger.js';
import config from '../config.js';
import settings from '../settings.js';
import { toDbString } from './bigint.js';

export interface Token {
    _id: string;                // Typically the symbol
    symbol: string;
    name: string;
    precision: bigint;          // Number of decimal places (0-18)
    issuer?: string;            // For non-native tokens
    maxSupply: bigint;          // Maximum token supply
    currentSupply: bigint;      // Current circulating supply
}

export async function getTokenByIdentifier(symbol: string, issuer?: string): Promise<Token | null> {
    logger.debug(`[token-utils] Fetching token: ${symbol}${issuer ? '@' + issuer : ''}`);
    if (symbol === config.nativeTokenSymbol) {
        return {
            _id: config.nativeTokenSymbol,
            symbol: config.nativeTokenSymbol,
            name: `${config.nativeTokenSymbol} (Native)`,
            precision: 8n,
            issuer: undefined,
            maxSupply: 0n,
            currentSupply: 0n,
        } as Token;
    }
    const query: any = { _id: symbol };
    if (issuer) {
        query.issuer = issuer;
    }
    const tokenDoc = await cache.findOnePromise('tokens', query);
    if (tokenDoc) {
        return tokenDoc as Token;
    }
    logger.warn(`[token-utils] Token ${symbol}${issuer ? '@' + issuer : ''} not found in 'tokens' collection.`);
    return null;
}


export function getLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string, feeTier: number): string {
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `LP_${token1}_${token2}_${feeTier}`;
} 

export async function adjustTokenSupply(tokenIdentifier: string, amount: bigint): Promise<boolean> {
    const token = await cache.findOnePromise('tokens', { symbol: tokenIdentifier });
    if (!token) {
        logger.error(`[token-utils] Token ${tokenIdentifier} not found`);
        return false;
    }
    const newSupply = BigInt(token.currentSupply) + amount;
    const updateResult = await cache.updateOnePromise('tokens', { symbol: tokenIdentifier }, { $set: { currentSupply: toDbString(newSupply) } });
    if (!updateResult) {
        logger.error(`[token-utils] Failed to update token supply for ${tokenIdentifier}`);
        return false;
    }
    return true;
} 

/**
 * Checks whether a token is issued by this node's configured bridge account
 */
export async function isTokenIssuedByNode(symbol: string): Promise<boolean> {
    const token = await cache.findOnePromise('tokens', { _id: symbol });
    if (!token) {
        logger.warn(`[token-utils] Token ${symbol} not found while checking issuer.`);
        return false;
    }
    const isIssuer = token.issuer === settings.steemBridgeAccount;
    if (!isIssuer) {
        logger.warn(`[token-utils] Token ${symbol} issuer (${token.issuer}) does not match node bridge account (${settings.steemBridgeAccount}).`);
    }
    return isIssuer;
}