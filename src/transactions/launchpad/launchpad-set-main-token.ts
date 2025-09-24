import cache from '../../cache.js';
import logger from '../../logger.js';
import validate from '../../validation/index.js';

export interface LaunchpadSetMainTokenData {
    launchpadId: string;
    mainTokenId: string; // e.g., MYT@echelon-node1
}

export async function validateTx(data: LaunchpadSetMainTokenData, sender: string): Promise<boolean> {
    try {
        // Validate that sender is launchpad owner
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) return false;
        if (lp.issuer !== sender) return false;
        if (!validate.string(data.mainTokenId, 64, 3)) return false;
        return true;
    } catch (e) {
        logger.error('[launchpad-set-main-token] validate error', e);
        return false;
    }
}

export async function processTx(data: LaunchpadSetMainTokenData, _sender: string): Promise<boolean> {
    try {
        const ok = await cache.updateOnePromise(
            'launchpads',
            { _id: data.launchpadId },
            {
                $set: { mainTokenId: data.mainTokenId, updatedAt: new Date().toISOString() },
            }
        );
        return !!ok;
    } catch (e) {
        logger.error('[launchpad-set-main-token] process error', e);
        return false;
    }
}
