import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { LaunchpadConfigureAirdropData, LaunchpadStatus, TokenDistributionRecipient } from './launchpad-interfaces.js';

export async function validateTx(data: LaunchpadConfigureAirdropData, sender: string): Promise<boolean> {
    logger.debug(`[launchpad-configure-airdrop] Validating airdrop config from ${sender} for launchpad ${data.launchpadId}`);

    // Validate that sender is launchpad owner

    if (!data.launchpadId || !Array.isArray(data.recipients) || data.recipients.length === 0) {
        logger.warn('[launchpad-configure-airdrop] Missing required fields: launchpadId, recipients array.');
        return false;
    }

    if (data.recipients.length > 10000) {
        logger.warn('[launchpad-configure-airdrop] Too many recipients. Maximum 10,000 allowed.');
        return false;
    }

    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) {
        logger.warn(`[launchpad-configure-airdrop] Launchpad ${data.launchpadId} not found.`);
        return false;
    }

    if (launchpad.issuer !== sender) {
        logger.warn(`[launchpad-configure-airdrop] Only launchpad owner can configure airdrop.`);
        return false;
    }

    // Only allow airdrop configuration in early stages
    const configurableStatuses = [
        LaunchpadStatus.UPCOMING,
        LaunchpadStatus.PENDING_VALIDATION,
        LaunchpadStatus.PRESALE_SCHEDULED,
        LaunchpadStatus.TOKEN_GENERATION_EVENT,
    ];

    if (!configurableStatuses.includes(launchpad.status)) {
        logger.warn(`[launchpad-configure-airdrop] Cannot configure airdrop in current status: ${launchpad.status}`);
        return false;
    }

    // Validate each recipient
    const seenUsernames = new Set<string>();
    let totalAirdropAmount = toBigInt(0);

    for (const recipient of data.recipients) {
        if (!recipient.username || !recipient.amount) {
            logger.warn('[launchpad-configure-airdrop] Missing username or amount in recipient.');
            return false;
        }

        if (!validate.string(recipient.username, 32, 3)) {
            logger.warn(`[launchpad-configure-airdrop] Invalid username: ${recipient.username}`);
            return false;
        }

        if (!validate.bigint(recipient.amount, false, false)) {
            logger.warn(`[launchpad-configure-airdrop] Invalid amount for ${recipient.username}: ${recipient.amount}`);
            return false;
        }

        if (seenUsernames.has(recipient.username)) {
            logger.warn(`[launchpad-configure-airdrop] Duplicate username in recipients: ${recipient.username}`);
            return false;
        }

        seenUsernames.add(recipient.username);
        totalAirdropAmount += toBigInt(recipient.amount);
    }

    // Check if tokenomics has airdrop allocation
    if (launchpad.tokenomicsSnapshot?.allocations) {
        const airdropAllocation = launchpad.tokenomicsSnapshot.allocations.find((a: any) => a.recipient === TokenDistributionRecipient.AIRDROP_REWARDS);

        if (!airdropAllocation) {
            logger.warn('[launchpad-configure-airdrop] No AIRDROP_REWARDS allocation found in tokenomics.');
            return false;
        }

        // Calculate max allowed airdrop amount
        const totalSupply = toBigInt(launchpad.tokenToLaunch.totalSupply);
        const maxAirdropAmount = (totalSupply * toBigInt(airdropAllocation.percentage)) / toBigInt(100);

        if (totalAirdropAmount > maxAirdropAmount) {
            logger.warn(`[launchpad-configure-airdrop] Total airdrop amount ${totalAirdropAmount} exceeds allocation ${maxAirdropAmount}.`);
            return false;
        }
    }

    logger.debug('[launchpad-configure-airdrop] Validation passed.');
    return true;
}

export async function processTx(data: LaunchpadConfigureAirdropData, sender: string, _transactionId: string): Promise<boolean> {
    logger.debug(`[launchpad-configure-airdrop] Processing airdrop config from ${sender} for ${data.launchpadId}`);

    try {
        const now = new Date().toISOString();

        // Convert recipients to database format
        const recipientsForDb = data.recipients.map(recipient => ({
            username: recipient.username,
            amount: toDbString(recipient.amount),
            claimed: false,
        }));

        const update = {
            airdropRecipients: recipientsForDb,
            updatedAt: now,
        };

        const result = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: update });

        if (!result) {
            logger.error(`[launchpad-configure-airdrop] Failed to update launchpad ${data.launchpadId}`);
            return false;
        }

        await logEvent('launchpad', 'airdrop_configured', sender, {
            launchpadId: data.launchpadId,
            recipientCount: data.recipients.length,
            totalAmount: toDbString(data.recipients.reduce((sum, r) => sum + toBigInt(r.amount), toBigInt(0))),
        });

        logger.debug(`[launchpad-configure-airdrop] Airdrop configured for ${data.launchpadId} with ${data.recipients.length} recipients`);
        return true;
    } catch (error) {
        logger.error(`[launchpad-configure-airdrop] Error processing: ${error}`);
        return false;
    }
}
