import cache from '../../cache.js';
import logger from '../../logger.js';
import { LaunchpadStatus } from './launchpad-interfaces.js';

export interface LaunchpadUpdateStatusData {
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
        LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET,
    ],
    [LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET]: [LaunchpadStatus.TOKEN_GENERATION_EVENT, LaunchpadStatus.CANCELLED],
    [LaunchpadStatus.PRESALE_SUCCEEDED_HARDCAP_MET]: [LaunchpadStatus.TOKEN_GENERATION_EVENT, LaunchpadStatus.CANCELLED],
    [LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET]: [LaunchpadStatus.CANCELLED],
    [LaunchpadStatus.TOKEN_GENERATION_EVENT]: [LaunchpadStatus.TRADING_LIVE],
    [LaunchpadStatus.TRADING_LIVE]: [LaunchpadStatus.COMPLETED],
    [LaunchpadStatus.COMPLETED]: [],
    [LaunchpadStatus.CANCELLED]: [],
};

export async function validateTx(data: LaunchpadUpdateStatusData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.launchpadId || !data.newStatus) return { valid: false, error: 'missing launchpadId or newStatus' };
        // Validate that the sender is the launchpad owner
        const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!launchpad) return { valid: false, error: 'launchpad not found' };
        if (launchpad.issuer !== sender) return { valid: false, error: 'not launchpad owner' };
        const currentStatus: LaunchpadStatus = launchpad.status;
        const desired = data.newStatus as LaunchpadStatus;
        if (!(desired in LaunchpadStatus)) return { valid: false, error: 'invalid newStatus' };

        const allowed = ALLOWED_TRANSITIONS[currentStatus as LaunchpadStatus] || [];
        if (!allowed.includes(desired)) return { valid: false, error: 'invalid status transition' };

        return { valid: true };
    } catch (e) {
        logger.error('[launchpad-update-status] validate error', e);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: LaunchpadUpdateStatusData, _sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!launchpad) return { valid: false, error: 'launchpad not found' };

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
            return ok ? { valid: true } : { valid: false, error: 'update failed' };
    } catch (e) {
        logger.error('[launchpad-update-status] process error', e);
        return { valid: false, error: 'internal error' };
    }
}
