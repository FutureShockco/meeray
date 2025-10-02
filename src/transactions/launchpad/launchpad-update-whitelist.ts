import cache from '../../cache.js';
import logger from '../../logger.js';
import validate from '../../validation/index.js';

export interface LaunchpadUpdateWhitelistData {
    launchpadId: string;
    action: 'ADD' | 'REMOVE' | 'ENABLE' | 'DISABLE' | 'REPLACE';
    addresses?: string[];
}

export async function validateTx(data: LaunchpadUpdateWhitelistData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        // Require that the sender is the launchpad owner rather than relying on a userId field in the payload

        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) {
            logger.error(`[launchpad-update-whitelist] validate failed: launchpad not found (launchpadId=${data.launchpadId})`);
            return { valid: false, error: 'launchpad not found' };
        }

        if (lp.issuer !== sender) {
            logger.error(`[launchpad-update-whitelist] validate failed: sender is not launchpad owner (sender=${sender} owner=${lp.issuer})`);
            return { valid: false, error: 'not launchpad owner' };
        }

        if (['ADD', 'REMOVE', 'REPLACE'].includes(data.action)) {
            if (!Array.isArray(data.addresses) || data.addresses.length === 0) {
                logger.error('[launchpad-update-whitelist] validate failed: addresses missing or not an array for action requiring addresses');
                return { valid: false, error: 'addresses missing' };
            }
            for (const addr of data.addresses) {
                if (!validate.string(addr, 16, 3)) {
                    logger.error(`[launchpad-update-whitelist] validate failed: invalid address in addresses array (address=${addr})`);
                    return { valid: false, error: 'invalid address' };
                }
            }
        }

        return { valid: true };
    } catch (e) {
        logger.error('[launchpad-update-whitelist] validate error', e);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: LaunchpadUpdateWhitelistData, _sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) return { valid: false, error: 'launchpad not found' };

        const existing: string[] = lp.presale?.whitelist || [];
        let next = existing;

        switch (data.action) {
            case 'ENABLE':
                await cache.updateOnePromise(
                    'launchpads',
                    { _id: data.launchpadId },
                    { $set: { 'presale.whitelistEnabled': true, updatedAt: new Date().toISOString() } }
                );
                return { valid: true };
            case 'DISABLE':
                await cache.updateOnePromise(
                    'launchpads',
                    { _id: data.launchpadId },
                    { $set: { 'presale.whitelistEnabled': false, updatedAt: new Date().toISOString() } }
                );
                return { valid: true };
            case 'ADD':
                next = Array.from(new Set(existing.concat(data.addresses || [])));
                break;
            case 'REMOVE':
                next = existing.filter(a => !(data.addresses || []).includes(a));
                break;
            case 'REPLACE':
                next = Array.from(new Set(data.addresses || []));
                break;
        }

        const ok = await cache.updateOnePromise(
            'launchpads',
            { _id: data.launchpadId },
            {
                $set: { 'presale.whitelist': next, updatedAt: new Date().toISOString() },
            }
        );
        return ok ? { valid: true } : { valid: false, error: 'update failed' };
    } catch (e) {
        logger.error('[launchpad-update-whitelist] process error', e);
        return { valid: false, error: 'internal error' };
    }
}
