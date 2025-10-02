import cache from '../../cache.js';
import logger from '../../logger.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { TokenUpdateData } from './token-interfaces.js';

export async function validateTx(data: TokenUpdateData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (data.description === undefined && data.logoUrl === undefined && data.websiteUrl === undefined) {
            logger.warn('[token-update:validation] No updatable fields provided (name, description, logoUrl, websiteUrl).');
            return { valid: false, error: 'No updatable fields provided' };
        }
        if (data.description !== undefined && !validate.string(data.description, 512, 0)) {
            logger.warn('[token-update:validation] Invalid new description length (must be 0-500 characters).');
            return { valid: false, error: 'Invalid new description length' };
        }
        if (data.logoUrl !== undefined && !validate.validateLogoUrl(data.logoUrl, 512)) {
            logger.warn('[token-update:validation] Invalid new logoUrl format or length.');
            return { valid: false, error: 'Invalid new logoUrl format or length' };
        }
        if (data.websiteUrl !== undefined && !validate.validateUrl(data.websiteUrl, 512)) {
            logger.warn('[token-update:validation] Invalid new websiteUrl format or length.');
            return { valid: false, error: 'Invalid new websiteUrl format or length' };
        }

        if (!(await validate.isIssuer(sender, data.symbol))) return { valid: false, error: 'Not the token issuer' };

        return { valid: true };
    } catch (error) {
        logger.error(`[token-update:validation] Error validating token update for ${data.symbol} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: TokenUpdateData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const token = await cache.findOnePromise('tokens', { _id: data.symbol });
        if (!token) {
            logger.error(`[token-update:process] Token ${data.symbol} not found`);
            return { valid: false, error: 'Token not found' };
        }
        const updateData: any = {};
        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined) updateData.description = data.description;
        if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
        if (data.websiteUrl !== undefined) updateData.websiteUrl = data.websiteUrl;
        if (Object.keys(updateData).length === 0) {
            logger.warn(`[token-update:process] No fields to update for token ${data.symbol}`);
            return { valid: false, error: 'No fields to update' };
        }
        const updateSuccess = await cache.updateOnePromise('tokens', { _id: data.symbol }, { $set: updateData });
        if (!updateSuccess) {
            logger.error(`[token-update:process] Failed to update token ${data.symbol}`);
            return { valid: false, error: 'Failed to update token' };
        }
        await logEvent('token', 'update', sender, {
            symbol: data.symbol,
            issuer: sender,
            updatedFields: updateData,
        });
        return { valid: true };
    } catch (error) {
        logger.error(`[token-update:process] Error updating token ${data.symbol}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
