import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';

export interface LaunchpadUpdateWhitelistData {
  userId: string;
  launchpadId: string;
  action: 'ADD' | 'REMOVE' | 'ENABLE' | 'DISABLE' | 'REPLACE';
  addresses?: string[];
}

export async function validateTx(data: LaunchpadUpdateWhitelistData, sender: string): Promise<boolean> {
  try {
    if (sender !== data.userId) {
      logger.error(`[launchpad-update-whitelist] validate failed: sender mismatch (sender=${sender} data.userId=${data.userId})`);
      return false;
    }

    const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!lp) {
      logger.error(`[launchpad-update-whitelist] validate failed: launchpad not found (launchpadId=${data.launchpadId})`);
      return false;
    }

    if (['ADD','REMOVE','REPLACE'].includes(data.action)) {
      if (!Array.isArray(data.addresses) || data.addresses.length === 0) {
        logger.error('[launchpad-update-whitelist] validate failed: addresses missing or not an array for action requiring addresses');
        return false;
      }
      for (const addr of data.addresses) {
        if (!validate.string(addr, 16, 3)) {
          logger.error(`[launchpad-update-whitelist] validate failed: invalid address in addresses array (address=${addr})`);
          return false;
        }
      }
    }

    return true;
  } catch (e) {
    logger.error('[launchpad-update-whitelist] validate error', e);
    return false;
  }
}

export async function processTx(data: LaunchpadUpdateWhitelistData, sender: string): Promise<boolean> {
  try {
    const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!lp) return false;

    const existing: string[] = lp.presale?.whitelist || [];
    let next = existing;

    switch (data.action) {
      case 'ENABLE':
        await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: { 'presale.whitelistEnabled': true, updatedAt: new Date().toISOString() } });
        return true;
      case 'DISABLE':
        await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: { 'presale.whitelistEnabled': false, updatedAt: new Date().toISOString() } });
        return true;
      case 'ADD':
        next = Array.from(new Set(existing.concat(data.addresses || [])));
        break;
      case 'REMOVE':
        next = existing.filter((a) => !(data.addresses || []).includes(a));
        break;
      case 'REPLACE':
        next = Array.from(new Set(data.addresses || []));
        break;
    }

    const ok = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, {
      $set: { 'presale.whitelist': next, updatedAt: new Date().toISOString() }
    });
    return !!ok;
  } catch (e) {
    logger.error('[launchpad-update-whitelist] process error', e);
    return false;
  }
}