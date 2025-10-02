import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { setTokenDecimals, toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { TokenData } from './token-interfaces.js';

export async function validateTx(data: TokenData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!(await validate.newToken(data))) return { valid: false, error: 'Invalid token data' };

        if (!(await validate.userBalances(sender, [{ symbol: config.nativeTokenSymbol, amount: toBigInt(config.tokenCreationFee) }]))) return { valid: false, error: 'Insufficient balance' };
        return { valid: true };
    } catch (error) {
        logger.error(`[token-create:validation] Error validating token creation: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: TokenData, sender: string, transactionId: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const initialSupply = toBigInt(data.initialSupply || 0);
        const tokenToStore: TokenData = {
            _id: data.symbol,
            symbol: data.symbol,
            name: data.name,
            issuer: sender,
            precision: data.precision,
            maxSupply: toDbString(data.maxSupply || 0),
            currentSupply: toDbString(initialSupply),
            mintable: data.mintable === undefined ? true : data.mintable,
            burnable: data.burnable === undefined ? true : data.burnable,
            description: data.description || '',
            logoUrl: data.logoUrl || '',
            websiteUrl: data.websiteUrl || '',
            createdAt: new Date().toISOString(),
        };
        if (initialSupply > toBigInt(0)) {
            const adjustedSupply = await adjustUserBalance(sender, tokenToStore.symbol, toBigInt(initialSupply));
            if (!adjustedSupply) {
                logger.error(`[token-create:process] Failed to adjust balance for ${sender} when creating token ${tokenToStore.symbol}.`);
                return { valid: false, error: 'Failed to adjust balance' };
            }
        }
        const feeDeducted = await adjustUserBalance(sender, config.nativeTokenSymbol, toBigInt(-config.tokenCreationFee));
        if (!feeDeducted) {
            logger.error(`[token-create:process] Failed to deduct token creation fee from ${sender}.`);
            return { valid: false, error: 'Failed to deduct token creation fee' };
        }
        const newToken = await cache.insertOnePromise('tokens', tokenToStore);
        if (!newToken) {
            logger.error(`[token-create:process] Failed to store new token ${data.symbol} in the database.`);
            return { valid: false, error: 'Failed to store new token' };
        }

        setTokenDecimals(data.symbol, data.precision);
        const logToken = { ...tokenToStore };
        delete logToken.logoUrl;
        delete logToken.websiteUrl;
        delete logToken.description;
        await logEvent('token', 'create', sender, logToken, transactionId);
        return { valid: true };
    } catch (error) {
        logger.error(`[token-create:process] Error processing token creation for ${data.symbol} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
