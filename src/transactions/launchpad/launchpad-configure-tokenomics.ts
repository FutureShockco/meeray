import cache from '../../cache.js';
import logger from '../../logger.js';
import { toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { LaunchpadConfigureTokenomicsData, LaunchpadStatus } from './launchpad-interfaces.js';

export async function validateTx(data: LaunchpadConfigureTokenomicsData, sender: string): Promise<{ valid: boolean; error?: string }> {
    logger.debug(`[launchpad-configure-tokenomics] Validating tokenomics config from ${sender} for launchpad ${data.launchpadId}`);

    // Validate that sender is launchpad owner

    if (!data.launchpadId || !data.tokenomics) {
        logger.warn('[launchpad-configure-tokenomics] Missing required fields: launchpadId, tokenomics.');
        return { valid: false, error: 'missing required fields' };
    }

    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) {
        logger.warn(`[launchpad-configure-tokenomics] Launchpad ${data.launchpadId} not found.`);
        return { valid: false, error: 'launchpad not found' };
    }

    if (launchpad.issuer !== sender) {
        logger.warn(`[launchpad-configure-tokenomics] Only launchpad owner can configure tokenomics.`);
        return { valid: false, error: 'not launchpad owner' };
    }

    // Only allow tokenomics configuration in early stages
    const configurableStatuses = [LaunchpadStatus.UPCOMING, LaunchpadStatus.PENDING_VALIDATION];

    if (!configurableStatuses.includes(launchpad.status)) {
        logger.warn(`[launchpad-configure-tokenomics] Cannot configure tokenomics in current status: ${launchpad.status}`);
        return { valid: false, error: 'invalid launchpad status' };
    }

    const tokenomics = data.tokenomics;

    // Validate allocations percentage sum <= 100
    if (Array.isArray(tokenomics.allocations)) {
        let sum = 0;
        for (const alloc of tokenomics.allocations) {
            if (alloc.percentage < 0 || alloc.percentage > 100) {
                logger.warn('[launchpad-configure-tokenomics] Allocation percentage out of range 0-100.');
                return { valid: false, error: 'allocation percentage out of range' };
            }
            sum += alloc.percentage;
        }
        if (sum > 100) {
            logger.warn('[launchpad-configure-tokenomics] Total allocation percentages exceed 100.');
            return { valid: false, error: 'allocations exceed 100' };
        }
    }

    // Validate vesting schedules
    if (Array.isArray(tokenomics.allocations)) {
        for (const alloc of tokenomics.allocations) {
            const vs = alloc.vestingSchedule;
            if (vs) {
                if (!validate.integer(vs.durationMonths, false, false)) {
                    logger.warn('[launchpad-configure-tokenomics] Invalid vesting durationMonths.');
                    return { valid: false, error: 'invalid vesting duration' };
                }
                if (vs.cliffMonths !== undefined && !validate.integer(vs.cliffMonths, true, false)) {
                    logger.warn('[launchpad-configure-tokenomics] Invalid vesting cliffMonths.');
                    return { valid: false, error: 'invalid cliffMonths' };
                }
                if (vs.cliffMonths !== undefined && (vs.cliffMonths as number) > (vs.durationMonths as number)) {
                    logger.warn('[launchpad-configure-tokenomics] vesting cliffMonths cannot exceed durationMonths.');
                    return { valid: false, error: 'cliff exceeds duration' };
                }
            }
        }
    }

    logger.debug('[launchpad-configure-tokenomics] Validation passed.');
    return { valid: true };
}

export async function processTx(data: LaunchpadConfigureTokenomicsData, sender: string, _transactionId: string): Promise<{ valid: boolean; error?: string }> {
    logger.debug(`[launchpad-configure-tokenomics] Processing tokenomics config from ${sender} for ${data.launchpadId}`);

    try {
        const now = new Date().toISOString();

        // Convert tokenomics for storage
        const tokenomicsForDb = {
            ...data.tokenomics,
            totalSupply: toDbString(data.tokenomics.totalSupply),
        };

        const update = {
            tokenomicsSnapshot: tokenomicsForDb,
            updatedAt: now,
        };

        const result = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: update });

        if (!result) {
            logger.error(`[launchpad-configure-tokenomics] Failed to update launchpad ${data.launchpadId}`);
            return { valid: false, error: 'update failed' };
        }

        await logEvent('launchpad', 'tokenomics_configured', sender, {
            launchpadId: data.launchpadId,
            totalAllocations: data.tokenomics.allocations?.length || 0,
        });

        logger.debug(`[launchpad-configure-tokenomics] Tokenomics configured for ${data.launchpadId}`);
        return { valid: true };
    } catch (error) {
        logger.error(`[launchpad-configure-tokenomics] Error processing: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
