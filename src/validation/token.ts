import cache from '../cache.js';
import config from '../config.js';
import logger from '../logger.js';
import { toBigInt } from '../utils/bigint.js';
import validate from './index.js';

const BURN_ACCOUNT_NAME = config.burnAccountName || 'null';

/**
 * Validates one or more token symbols
 * @param symbols Array of symbols to validate
 * @returns True if all symbols are valid, false otherwise
 */
export const tokenSymbols = (symbols: any[] | any): boolean => {
    const arr = Array.isArray(symbols) ? symbols : [symbols];
    for (const symbol of arr) {
        if (!validate.string(symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[token:validation] Invalid token symbol format: ${symbol}.`);
            return false;
        }
    }
    return true;
};

/**
 * Validates a transfer of tokens
 * @param sender Sender account name
 * @param symbol Token symbol
 * @param to Recipient account name
 * @param amount Transfer amount
 * @param memo Optional memo
 * @returns True if the transfer is valid, false otherwise
 */
export const tokenTransfer = (sender: string, symbol: string, to: string, amount: string | bigint, memo?: string, isTransfer?: boolean): boolean => {
    if (!symbol || !to || !amount) {
        logger.warn('[token-transfer:validation] Invalid data: Missing required fields (symbol, to, amount).');
        return false;
    }
    if (!validate.tokenSymbols(symbol)) {
        logger.warn(`[token-transfer:validation] Invalid token symbol format: ${symbol}.`);
        return false;
    }
    if (to !== BURN_ACCOUNT_NAME && !validate.string(to, 16, 3)) {
        logger.warn(`[token-transfer:validation] Invalid recipient account name format: ${to}.`);
        return false;
    }
    if (isTransfer && to === sender) {
        logger.warn(`[token-transfer:validation] Sender and recipient cannot be the same: ${sender}>${to}.`);
        return false;
    }
    if (memo !== undefined && !validate.string(memo, 512, 0)) {
        logger.warn(`[token-transfer:validation] Memo can not be longer than 512 it is ${memo.length}.`);
        return false;
    }
    if (!validate.bigint(amount, false, false, toBigInt(1))) {
        logger.warn(`[token-transfer:validation] Invalid amount: ${toBigInt(amount).toString()}. Must be a positive integer.`);
        return false;
    }
    return true;
};

/**
 * Validates token values like allowed transaction types
 * (array of strictly positive integers) with at least 1 element
 * @param value Value to validate
 * @param maxLength Maximum allowed length of the array
 * @returns True if the array is valid, false otherwise
 */

export const newToken = async (data: any): Promise<boolean> => {
    if (!data.symbol || !data.name || data.maxSupply === undefined || data.precision === undefined || data.initialSupply === undefined) {
        logger.warn('[token-config:validation] Invalid data: Missing required fields (symbol, name, maxSupply, precision, initialSupply).');
        return false;
    }
    if (!validate.tokenSymbols(data.symbol)) {
        logger.warn('[token-config:validation] Invalid symbol format.');
        return false;
    }
    if (data.symbol.startsWith('LP_')) {
        logger.warn('[token-config:validation] Token symbol cannot start with "LP_". This prefix is reserved for liquidity pool tokens.');
        return false;
    }
    if (!validate.string(data.name, config.tokenNameMaxLength, 3, config.tokenNameAllowedChars)) {
        logger.warn(`[token-config:validation] Invalid token name format: ${data.name}.`);
        return false;
    }
    if (!validate.integer(data.precision, true, false, 18, 0)) {
        logger.warn('[token-config:validation] Invalid precision (must be 0-18).');
        return false;
    }
    if (!validate.bigint(data.maxSupply, false, false, toBigInt(1))) {
        logger.warn('[token-config:validation] Invalid maxSupply. Must be a positive integer (min 1).');
        return false;
    }
    if (!validate.bigint(data.initialSupply, true, false, toBigInt(0))) {
        logger.warn('[token-config:validation] Invalid initialSupply. Must be non-negative.');
        return false;
    }
    if (toBigInt(data.initialSupply) > toBigInt(data.maxSupply)) {
        logger.warn('[token-config:validation] Invalid initialSupply. Cannot be greater than maxSupply.');
        return false;
    }
    if (data.mintable !== undefined && typeof data.mintable !== 'boolean') {
        logger.warn('[token-config:validation] Invalid mintable flag. Must be boolean.');
        return false;
    }
    if (data.burnable !== undefined && typeof data.burnable !== 'boolean') {
        logger.warn('[token-config:validation] Invalid burnable flag. Must be boolean.');
        return false;
    }
    if (data.description !== undefined) {
        if (!validate.string(data.description, 512, 0)) {
            logger.warn('[token-config:validation] Invalid new description length (must be 0-500 characters).');
            return false;
        }
    }
    if (data.logoUrl !== undefined) {
        if (!validate.validateLogoUrl(data.logoUrl, 512)) {
            logger.warn('[token-config:validation] Invalid new logoUrl format or length.');
            return false;
        }
    }
    if (data.websiteUrl !== undefined) {
        if (!validate.validateUrl(data.websiteUrl, 512)) {
            logger.warn('[token-config:validation] Invalid new websiteUrl format or length.');
            return false;
        }
    }
    if (await validate.tokenExists(data.symbol)) {
        logger.warn(`[token-config:validation] Token with symbol ${data.symbol} already exists.`);
        return false;
    }
    return true;
};

/**
 * Validates if a token exists
 * @param symbol Token symbol to check
 * @returns True if the token exists, false otherwise
 */
export const tokenExists = async (symbol: string): Promise<boolean> => {
    if (!validate.tokenSymbols(symbol)) return false;

    if (!validate.string(symbol, 10, 3, config.tokenSymbolAllowedChars)) {
        logger.debug(`[token-exists:validation] Invalid token symbol format: ${symbol}.`);
        return false;
    }
    const existingToken = await cache.findOnePromise('tokens', { _id: symbol });
    if (existingToken) {
        logger.debug(`[token-exists:validation] Token with symbol ${symbol} already exists.`);
        return true;
    }
    return false;
};

/**
 * Validates if a token exists
 * @param symbol Token symbol to check
 * @returns True if the token exists, false otherwise
 */
export const isIssuer = async (sender: string, symbol: string): Promise<boolean> => {
    if (!validate.tokenSymbols(symbol)) return false;

    const isIssuer = await cache.findOnePromise('tokens', { sender: sender, _id: symbol });
    if (!isIssuer) {
        logger.warn(`[token-issuer:validation] Sender ${sender} is not the issuer of the token ${symbol}.`);
        return false;
    }
    return true;
};

/**
 * Validates if a token exists
 * @param symbol Token symbol to check
 * @returns True if the token exists, false otherwise
 */
export const canMintToken = async (sender: string, symbol: string, amount: string | bigint): Promise<boolean> => {
    const token = await cache.findOnePromise('tokens', { _id: symbol });
    if (!token) {
        logger.warn(`[token-mint:validation] Token ${symbol} not found.`);
        return false;
    }
    if (!token.mintable) {
        logger.warn(`[token-mint:validation] Token ${symbol} is not mintable.`);
        return false;
    }
    const currentSupplyBigInt = toBigInt(token.currentSupply || 0);
    const maxSupplyBigInt = toBigInt(token.maxSupply);
    const amountBigInt = toBigInt(amount);
    if (currentSupplyBigInt + amountBigInt > maxSupplyBigInt) {
        logger.warn(`[token-mint:validation] Mint would exceed max supply for ${symbol}.`);
        return false;
    }
    const senderAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!senderAccount) {
        logger.warn(`[token-mint:validation] Sender account ${sender} not found.`);
        return false;
    }
    if (sender !== token.issuer && sender !== 'null') {
        logger.warn(`[token-mint:validation] Only token issuer and null can mint. Sender: ${sender}, Issuer: ${token.issuer}`);
        return false;
    }

    return true;
};

export default { tokenSymbols, newToken, tokenExists, isIssuer, canMintToken };
