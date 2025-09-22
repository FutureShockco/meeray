import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { LaunchpadStatus } from './launchpad-interfaces.js';

export interface LaunchpadUpdateStatusData {
  userId: string;
  launchpadId: string;
  newStatus: LaunchpadStatus | string;
  reason?: string;
}

const ALLOWED_TRANSITIONS: Record<LaunchpadStatus, LaunchpadStatus[]> = {
  [LaunchpadStatus.PENDING_VALIDATION]: [LaunchpadStatus.VALIDATION_FAILED, LaunchpadStatus.UPCOMING],
  [LaunchpadStatus.VALIDATION_FAILED]: [LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.UPCOMING]: [LaunchpadStatus.PRESALE_SCHEDULED, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_SCHEDULED]: [LaunchpadStatus.PRESALE_ACTIVE, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_ACTIVE]: [LaunchpadStatus.PRESALE_PAUSED, LaunchpadStatus.PRESALE_ENDED, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_PAUSED]: [LaunchpadStatus.PRESALE_ACTIVE, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_ENDED]: [
    LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET,
    LaunchpadStatus.PRESALE_SUCCEEDED_HARDCAP_MET,
    LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET
  ],
  [LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET]: [LaunchpadStatus.TOKEN_GENERATION_EVENT, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_SUCCEEDED_HARDCAP_MET]: [LaunchpadStatus.TOKEN_GENERATION_EVENT, LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET]: [LaunchpadStatus.CANCELLED],
  [LaunchpadStatus.TOKEN_GENERATION_EVENT]: [LaunchpadStatus.TRADING_LIVE],
  [LaunchpadStatus.TRADING_LIVE]: [LaunchpadStatus.COMPLETED],
  [LaunchpadStatus.COMPLETED]: [],
  [LaunchpadStatus.CANCELLED]: []
};

export async function validateTx(data: LaunchpadUpdateStatusData, sender: string): Promise<boolean> {
  try {
    if (!data.launchpadId || !data.newStatus) return false;
    if (sender !== data.userId) return false;

    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) return false;

    const currentStatus: LaunchpadStatus = launchpad.status;
    const desired = data.newStatus as LaunchpadStatus;
    if (!(desired in LaunchpadStatus)) return false;

    const allowed = ALLOWED_TRANSITIONS[currentStatus as LaunchpadStatus] || [];
    if (!allowed.includes(desired)) return false;

    return true;
  } catch (e) {
    logger.error('[launchpad-update-status] validate error', e);
    return false;
  }
}

export async function processTx(data: LaunchpadUpdateStatusData, sender: string): Promise<boolean> {
  try {
    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) return false;

    const nowIso = new Date().toISOString();
    const update: any = { status: data.newStatus, updatedAt: nowIso };

    // Record start/end real timestamps for presale
    if (data.newStatus === LaunchpadStatus.PRESALE_ACTIVE) {
      update['presale.startTimeActual'] = nowIso;
    }
    if (data.newStatus === LaunchpadStatus.PRESALE_ENDED) {
      update['presale.endTimeActual'] = nowIso;
    }

    const ok = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: update });
    return !!ok;
  } catch (e) {
    logger.error('[launchpad-update-status] process error', e);
    return false;
  }
}


