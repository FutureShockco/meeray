import cache from '../cache.js';
import logger from '../logger.js';
import config from '../config.js';

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
    
    if (symbol === config.nativeToken) { 
        return {
            _id: config.nativeToken,
            symbol: config.nativeToken,
            name: `${config.nativeToken} (Native)`,
            precision: 8n,
            issuer: undefined,
            maxSupply: 0n,
            currentSupply: 0n,
        } as Token;
    }

    const query: any = { _id: symbol }; // Tokens are keyed by symbol (_id)
    // For non-native tokens, an issuer might be part of their unique identification scheme or a property.

    if (issuer) {
        query.issuer = issuer; // Add this if your token documents have an 'issuer' field for disambiguation
    }

    const tokenDoc = await cache.findOnePromise('tokens', query);
    if (tokenDoc) {
        return tokenDoc as Token;
    }
    logger.warn(`[token-utils] Token ${symbol}${issuer ? '@' + issuer : ''} not found in 'tokens' collection.`);
    return null;
}

/**
 * Returns the canonical LP token symbol for a pair of tokens.
 * The order of tokens is sorted alphabetically to ensure uniqueness.
 */
export function getLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string): string {
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `LP_${token1}_${token2}`;
} 