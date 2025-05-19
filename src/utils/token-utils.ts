import cache from '../cache.js';
import logger from '../logger.js';
import config from '../config.js';

// Placeholder for Token type from your system - should match 'tokens' collection structure
export interface Token {
    _id: string; // Typically the symbol
    symbol: string;
    name: string;
    precision: number;
    issuer?: string; // For non-native tokens
    // other token fields like creator, maxSupply, currentSupply etc.
}

/**
 * Fetches a token definition from the cache by its symbol and optional issuer.
 */
export async function getTokenByIdentifier(symbol: string, issuer?: string): Promise<Token | null> {
    logger.debug(`[token-utils] Fetching token: ${symbol}${issuer ? '@' + issuer : ''}`);
    
    if (symbol === config.nativeToken) { 
        return {
            _id: config.nativeToken,
            symbol: config.nativeToken,
            name: `${config.nativeToken} (Native)`,
            precision: 8,
            issuer: undefined 
        } as Token;
    }

    const query: any = { _id: symbol }; // Tokens are keyed by symbol (_id)
    // For non-native tokens, an issuer might be part of their unique identification scheme or a property.
    // If your 'tokens' collection stores non-native tokens with an 'issuer' field:
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