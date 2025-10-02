import cache from '../../cache.js';
import logger from '../../logger.js';
import validate from '../../validation/index.js';

export interface LaunchpadSetMainTokenData {
    launchpadId: string;
    mainTokenId: string; // e.g., MYT@echelon-node1
}

export async function validateTx(data: LaunchpadSetMainTokenData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        // Validate that sender is launchpad owner
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) return { valid: false, error: 'launchpad not found' };
        if (lp.issuer !== sender) return { valid: false, error: 'not launchpad owner' };
        if (!validate.string(data.mainTokenId, 64, 3)) return { valid: false, error: 'invalid mainTokenId' };
        return { valid: true };
    } catch (e) {
        logger.error('[launchpad-set-main-token] validate error', e);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: LaunchpadSetMainTokenData, _sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const ok = await cache.updateOnePromise(
            'launchpads',
            { _id: data.launchpadId },
            {
                $set: { mainTokenId: data.mainTokenId, updatedAt: new Date().toISOString() },
            }
        );
        return ok ? { valid: true } : { valid: false, error: 'update failed' };
    } catch (e) {
        logger.error('[launchpad-set-main-token] process error', e);
        return { valid: false, error: 'internal error' };
    }
}
