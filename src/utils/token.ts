import cache from '../cache.js';
import logger from '../logger.js';
import settings from '../settings.js';
import { TokenData } from '../transactions/token/token-interfaces.js';
import { toBigInt, toDbString } from './bigint.js';

export interface Token {
    _id: string; 
    symbol: string;
    name: string;
    precision: bigint; 
    issuer?: string; 
    maxSupply: bigint; 
    currentSupply: bigint; 
}

export async function getToken(symbol: string): Promise<TokenData | null> {
    return (await cache.findOnePromise('tokens', { symbod: symbol })) as TokenData | null;
}

export function getLpTokenSymbol(tokenA_symbol: string, tokenB_symbol: string): string {
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `LP_${token1}_${token2}`;
}

export async function adjustTokenSupply(tokenSymbol: string, amount: bigint): Promise<bigint | null> {
    const token = await cache.findOnePromise('tokens', { symbol: tokenSymbol });
    if (!token) {
        logger.error(`[token-utils] Token ${tokenSymbol} not found`);
        return null;
    }
    const newSupply = toBigInt(token.currentSupply) + amount;
    const updateResult = await cache.updateOnePromise(
        'tokens',
        { symbol: tokenSymbol },
        { $set: { currentSupply: toDbString(newSupply) } }
    );
    if (!updateResult) {
        logger.error(`[token-utils] Failed to update token supply for ${tokenSymbol}`);
        return null;
    }
    return newSupply;
}

export async function isTokenIssuedByNode(symbol: string): Promise<boolean> {
    const token = await cache.findOnePromise('tokens', { _id: symbol });
    if (!token) {
        logger.warn(`[token-utils] Token ${symbol} not found while checking issuer.`);
        return false;
    }
    const isIssuer = token.issuer === settings.steemBridgeAccount;
    if (!isIssuer) {
        logger.warn(
            `[token-utils] Token ${symbol} issuer (${token.issuer}) does not match node bridge account (${settings.steemBridgeAccount}).`
        );
    }
    return isIssuer;
}
