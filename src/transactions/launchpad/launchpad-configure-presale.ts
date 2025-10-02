import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { LaunchpadConfigurePresaleData, LaunchpadStatus } from './launchpad-interfaces.js';

export async function validateTx(data: LaunchpadConfigurePresaleData, sender: string): Promise<{ valid: boolean; error?: string }> {
    logger.debug(`[launchpad-configure-presale] Validating presale config from ${sender} for launchpad ${data.launchpadId}`);

    if (!data.launchpadId || !data.presaleDetails) {
        logger.warn('[launchpad-configure-presale] Missing required fields: launchpadId, presaleDetails.');
        return { valid: false, error: 'missing required fields' };
    }

    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) {
        logger.warn(`[launchpad-configure-presale] Launchpad ${data.launchpadId} not found.`);
        return { valid: false, error: 'launchpad not found' };
    }

    if (launchpad.issuer !== sender) {
        logger.warn(`[launchpad-configure-presale] Only launchpad owner can configure presale.`);
        return { valid: false, error: 'not launchpad owner' };
    }

    // Only allow presale configuration in early stages
    const configurableStatuses = [LaunchpadStatus.UPCOMING, LaunchpadStatus.PENDING_VALIDATION];

    if (!configurableStatuses.includes(launchpad.status)) {
        logger.warn(`[launchpad-configure-presale] Cannot configure presale in current status: ${launchpad.status}`);
        return { valid: false, error: 'invalid launchpad status' };
    }

    const p = data.presaleDetails;

    // Validate presale details
    if (!validate.string(p.quoteAssetForPresaleSymbol, 10, 1, config.tokenSymbolAllowedChars)) {
        logger.warn('[launchpad-configure-presale] Invalid quoteAssetForPresaleSymbol.');
        return { valid: false, error: 'invalid quote asset symbol' };
    }

    if (!validate.bigint(p.pricePerToken, false, false)) {
        logger.warn('[launchpad-configure-presale] Invalid pricePerToken.');
        return { valid: false, error: 'invalid pricePerToken' };
    }

    if (!validate.bigint(p.hardCap, false, false)) {
        logger.warn('[launchpad-configure-presale] Invalid hardCap.');
        return { valid: false, error: 'invalid hardCap' };
    }

    if (p.softCap !== undefined && !validate.bigint(p.softCap, true, false)) {
        logger.warn('[launchpad-configure-presale] Invalid softCap.');
        return { valid: false, error: 'invalid softCap' };
    }

    if (p.softCap !== undefined && toBigInt(p.softCap) > toBigInt(p.hardCap)) {
        logger.warn('[launchpad-configure-presale] softCap cannot exceed hardCap.');
        return { valid: false, error: 'softCap exceeds hardCap' };
    }

    const startMs = Date.parse(p.startTime);
    const endMs = Date.parse(p.endTime);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        logger.warn('[launchpad-configure-presale] Invalid startTime/endTime.');
        return { valid: false, error: 'invalid startTime/endTime' };
    }

    logger.debug('[launchpad-configure-presale] Validation passed.');
    return { valid: true };
}

export async function processTx(data: LaunchpadConfigurePresaleData, sender: string, _transactionId: string): Promise<{ valid: boolean; error?: string }> {
    logger.debug(`[launchpad-configure-presale] Processing presale config from ${sender} for ${data.launchpadId}`);

    try {
        const now = new Date().toISOString();

        // Convert BigInt fields to strings for storage
        const presaleDetailsForDb = {
            ...data.presaleDetails,
            pricePerToken: toDbString(data.presaleDetails.pricePerToken),
            minContributionPerUser: toDbString(data.presaleDetails.minContributionPerUser),
            maxContributionPerUser: toDbString(data.presaleDetails.maxContributionPerUser),
            hardCap: toDbString(data.presaleDetails.hardCap),
            softCap: data.presaleDetails.softCap !== undefined ? toDbString(data.presaleDetails.softCap) : undefined,
        };

        const update = {
            presaleDetailsSnapshot: presaleDetailsForDb,
            updatedAt: now,
            presale: {
                totalQuoteRaised: '0',
                participants: [],
                status: 'NOT_STARTED',
            },
        };

        const result = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: update });

        if (!result) {
            logger.error(`[launchpad-configure-presale] Failed to update launchpad ${data.launchpadId}`);
            return { valid: false, error: 'update failed' };
        }

        await logEvent('launchpad', 'presale_configured', sender, {
            launchpadId: data.launchpadId,
            hardCap: toDbString(data.presaleDetails.hardCap),
            pricePerToken: toDbString(data.presaleDetails.pricePerToken),
        });

        logger.debug(`[launchpad-configure-presale] Presale configured for ${data.launchpadId}`);
        return { valid: true };
    } catch (error) {
        logger.error(`[launchpad-configure-presale] Error processing: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
