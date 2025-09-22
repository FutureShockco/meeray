import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';

export interface LaunchpadSetMainTokenData {
  userId: string;
  launchpadId: string;
  mainTokenId: string; // e.g., MYT@meeray-node1
}

export async function validateTx(data: LaunchpadSetMainTokenData, sender: string): Promise<boolean> {
  try {
    if (sender !== data.userId) return false;
    if (!validate.string(data.mainTokenId, 64, 3)) return false;
    const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!lp) return false;
    return true;
  } catch (e) {
    logger.error('[launchpad-set-main-token] validate error', e);
    return false;
  }
}

export async function processTx(data: LaunchpadSetMainTokenData, sender: string): Promise<boolean> {
  try {
    const ok = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, {
      $set: { mainTokenId: data.mainTokenId, updatedAt: new Date().toISOString() }
    });
    return !!ok;
  } catch (e) {
    logger.error('[launchpad-set-main-token] process error', e);
    return false;
  }
}