import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { Launchpad, LaunchpadStatus, PresaleDetails, Token, LaunchpadParticipatePresaleData } from './launchpad-interfaces.js'; // Import shared types

// --------------- TRANSACTION DATA INTERFACE ---------------

// --------------- TRANSACTION LOGIC ---------------

export async function validateTx(data: LaunchpadParticipatePresaleData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-participate-presale] Validating participation from ${sender} for launchpad ${data.launchpadId}: ${JSON.stringify(data)}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-participate-presale] Sender must match userId for participation.');
    return false;
  }

  if (!data.launchpadId || typeof data.contributionAmount !== 'number' || data.contributionAmount <= 0) {
    logger.warn('[launchpad-participate-presale] Missing or invalid fields: launchpadId, contributionAmount must be a positive number.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId }) as Launchpad | null;
  if (!launchpad) {
    logger.warn(`[launchpad-participate-presale] Launchpad project ${data.launchpadId} not found.`);
    return false;
  }

  if (launchpad.status !== LaunchpadStatus.PRESALE_ACTIVE) {
    logger.warn(`[launchpad-participate-presale] Launchpad ${data.launchpadId} presale is not active. Current status: ${launchpad.status}`);
    return false;
  }

  if (!launchpad.presaleDetailsSnapshot) {
    logger.warn(`[launchpad-participate-presale] Launchpad ${data.launchpadId} does not have presale details configured.`);
    return false;
  }
  const presaleDetails = launchpad.presaleDetailsSnapshot;

  // Check contribution limits
  if (data.contributionAmount < presaleDetails.minContributionPerUser) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} is below min limit ${presaleDetails.minContributionPerUser} for ${data.launchpadId}.`);
    return false;
  }
  if (data.contributionAmount > presaleDetails.maxContributionPerUser) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} exceeds max limit ${presaleDetails.maxContributionPerUser} for ${data.launchpadId}.`);
    return false;
  }

  // Check if hard cap would be exceeded (more complex check, consider current total raised)
  const currentTotalRaised = launchpad.presale?.totalQuoteRaised || 0;
  if ((currentTotalRaised + data.contributionAmount) > presaleDetails.hardCap) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} would exceed hard cap ${presaleDetails.hardCap} for ${data.launchpadId}. Current raised: ${currentTotalRaised}`);
    // This could be a partial fill scenario or outright rejection depending on rules.
    // For simplicity, let's reject if it strictly exceeds. A more advanced system might allow partial fills.
    return false;
  }

  // Whitelist check (if applicable)
  if (presaleDetails.whitelistRequired) {
    // Assuming whitelist is stored, e.g., in launchpad.presale.whitelistedUsers: string[]
    // const isWhitelisted = launchpad.presale?.whitelistedUsers?.includes(data.userId);
    // if (!isWhitelisted) {
    //   logger.warn(`[launchpad-participate-presale] User ${data.userId} is not whitelisted for ${data.launchpadId}.`);
    //   return false;
    // }
    logger.debug(`[launchpad-participate-presale] Whitelist check would be performed here if enabled for ${data.launchpadId}.`);
  }

  // User balance check
  const userAccount = await getAccount(data.userId);
  if (!userAccount) {
    logger.warn(`[launchpad-participate-presale] User account ${data.userId} not found.`);
    return false;
  }
  const contributionTokenIdentifier = `${presaleDetails.quoteAssetForPresaleSymbol}${presaleDetails.quoteAssetForPresaleIssuer ? '@' + presaleDetails.quoteAssetForPresaleIssuer : ''}`;
  const userBalance = userAccount.balances[contributionTokenIdentifier] || 0;
  if (userBalance < data.contributionAmount) {
    logger.warn(`[launchpad-participate-presale] Insufficient balance for ${data.userId}. Needs ${data.contributionAmount} ${contributionTokenIdentifier}, has ${userBalance}.`);
    return false;
  }

  logger.info(`[launchpad-participate-presale] Validation successful for ${sender} on launchpad ${data.launchpadId}.`);
  return true;
}

export async function process(data: LaunchpadParticipatePresaleData, sender: string): Promise<boolean> {
  logger.info(`[launchpad-participate-presale] Processing participation from ${sender} for ${data.launchpadId}: ${JSON.stringify(data)}`);
  try {
    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId }) as Launchpad | null;
    if (!launchpad || !launchpad.presaleDetailsSnapshot || !launchpad.presale) { // Should be caught by validation
        logger.error(`[launchpad-participate-presale] CRITICAL: Launchpad ${data.launchpadId} or its presale details not found during processing.`);
        return false;
    }

    const presaleDetails = launchpad.presaleDetailsSnapshot;
    const contributionTokenIdentifier = `${presaleDetails.quoteAssetForPresaleSymbol}${presaleDetails.quoteAssetForPresaleIssuer ? '@' + presaleDetails.quoteAssetForPresaleIssuer : ''}`;

    // 1. Deduct contribution currency from user
    const balanceAdjusted = await adjustBalance(sender, contributionTokenIdentifier, -data.contributionAmount);
    if (!balanceAdjusted) {
        logger.error(`[launchpad-participate-presale] Failed to deduct ${data.contributionAmount} ${contributionTokenIdentifier} from ${sender} for launchpad ${data.launchpadId}.`);
        return false;
    }

    // 2. Update Launchpad document: add participant and increment totalRaised
    // This needs to be an atomic operation or handled carefully to avoid race conditions.
    // For a cache-based system, it might involve fetching, updating, and saving.
    // A more robust DB would use atomic increments.

    const participantIndex = launchpad.presale.participants.findIndex(p => p.userId === data.userId);
    let updatedParticipantsList = [...launchpad.presale.participants];
    let newTotalRaised = (launchpad.presale.totalQuoteRaised || 0) + data.contributionAmount;

    if (participantIndex > -1) {
        updatedParticipantsList[participantIndex].quoteAmountContributed += data.contributionAmount;
    } else {
        updatedParticipantsList.push({
            userId: data.userId,
            quoteAmountContributed: data.contributionAmount,
            claimed: false // Tokens not claimable yet
        });
    }

    const updatePayload = {
        $set: {
            'presale.participants': updatedParticipantsList,
            'presale.totalQuoteRaised': newTotalRaised,
            updatedAt: new Date().toISOString(),
        }
    };
    
    // Check if hard cap is met with this contribution
    if (newTotalRaised >= presaleDetails.hardCap) {
        logger.info(`[launchpad-participate-presale] Hard cap reached for launchpad ${data.launchpadId}. New total: ${newTotalRaised}`);
        // Transition status if this contribution meets/exceeds hardcap
        // updatePayload.$set['status'] = LaunchpadStatus.PRESALE_ENDED; // Or a specific hardcap met status
        // The actual status transition to PRESALE_ENDED or similar should ideally be managed by a separate process
        // that monitors presale end times and contribution totals.
    }

    const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);

    if (!updateSuccessful) {
        logger.error(`[launchpad-participate-presale] Failed to update launchpad ${data.launchpadId} with participation from ${sender}. Rolling back balance.`);
        await adjustBalance(sender, contributionTokenIdentifier, data.contributionAmount); // Rollback
        return false;
    }

    // 3. Log event
    const eventDocument = {
      type: 'launchpadPresaleParticipation',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        launchpadId: data.launchpadId,
        userId: data.userId,
        contributionAmount: data.contributionAmount,
        contributionTokenSymbol: presaleDetails.quoteAssetForPresaleSymbol,
        contributionTokenIssuer: presaleDetails.quoteAssetForPresaleIssuer,
        newTotalRaised: newTotalRaised
      }
    };
    await new Promise<void>((resolve, reject) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[launchpad-participate-presale] CRITICAL: Failed to log participation event for ${data.launchpadId} by ${sender}: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    logger.info(`[launchpad-participate-presale] Participation by ${sender} for ${data.contributionAmount} ${contributionTokenIdentifier} in launchpad ${data.launchpadId} processed successfully.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-participate-presale] Error processing participation by ${sender} for ${data.launchpadId}: ${error}`);
    // Consider rollback if partial failure (e.g. balance deducted but DB update failed and rollback also failed)
    return false;
  }
} 