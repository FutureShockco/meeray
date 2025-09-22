import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { LaunchpadConfigurePresaleData, LaunchpadStatus } from './launchpad-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: LaunchpadConfigurePresaleData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-configure-presale] Validating presale config from ${sender} for launchpad ${data.launchpadId}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-configure-presale] Sender must match userId.');
    return false;
  }

  if (!data.launchpadId || !data.presaleDetails) {
    logger.warn('[launchpad-configure-presale] Missing required fields: launchpadId, presaleDetails.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
  if (!launchpad) {
    logger.warn(`[launchpad-configure-presale] Launchpad ${data.launchpadId} not found.`);
    return false;
  }

  if (launchpad.launchedByUserId !== sender) {
    logger.warn(`[launchpad-configure-presale] Only launchpad owner can configure presale.`);
    return false;
  }

  // Only allow presale configuration in early stages
  const configurableStatuses = [
    LaunchpadStatus.UPCOMING,
    LaunchpadStatus.PENDING_VALIDATION
  ];
  
  if (!configurableStatuses.includes(launchpad.status)) {
    logger.warn(`[launchpad-configure-presale] Cannot configure presale in current status: ${launchpad.status}`);
    return false;
  }

  const p = data.presaleDetails;
  
  // Validate presale details
  if (!validate.string(p.quoteAssetForPresaleSymbol, 10, 1, config.tokenSymbolAllowedChars)) {
    logger.warn('[launchpad-configure-presale] Invalid quoteAssetForPresaleSymbol.');
    return false;
  }
  
  if (!validate.bigint(p.pricePerToken, false, false)) {
    logger.warn('[launchpad-configure-presale] Invalid pricePerToken.');
    return false;
  }
  
  if (!validate.bigint(p.hardCap, false, false)) {
    logger.warn('[launchpad-configure-presale] Invalid hardCap.');
    return false;
  }
  
  if (p.softCap !== undefined && !validate.bigint(p.softCap, true, false)) {
    logger.warn('[launchpad-configure-presale] Invalid softCap.');
    return false;
  }
  
  if (p.softCap !== undefined && toBigInt(p.softCap) > toBigInt(p.hardCap)) {
    logger.warn('[launchpad-configure-presale] softCap cannot exceed hardCap.');
    return false;
  }

  const startMs = Date.parse(p.startTime);
  const endMs = Date.parse(p.endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    logger.warn('[launchpad-configure-presale] Invalid startTime/endTime.');
    return false;
  }

  logger.debug('[launchpad-configure-presale] Validation passed.');
  return true;
}

export async function processTx(data: LaunchpadConfigurePresaleData, sender: string, transactionId: string): Promise<boolean> {
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
      softCap: data.presaleDetails.softCap !== undefined 
        ? toDbString(data.presaleDetails.softCap) 
        : undefined,
    };

    const update = {
      presaleDetailsSnapshot: presaleDetailsForDb,
      updatedAt: now,
      presale: {
        totalQuoteRaised: '0',
        participants: [],
        status: 'NOT_STARTED'
      }
    };

    const result = await cache.updateOnePromise('launchpads', 
      { _id: data.launchpadId }, 
      { $set: update }
    );

    if (!result) {
      logger.error(`[launchpad-configure-presale] Failed to update launchpad ${data.launchpadId}`);
      return false;
    }

    await logEvent('launchpad', 'presale_configured', sender, {
      launchpadId: data.launchpadId,
      hardCap: toDbString(data.presaleDetails.hardCap),
      pricePerToken: toDbString(data.presaleDetails.pricePerToken)
    });

    logger.debug(`[launchpad-configure-presale] Presale configured for ${data.launchpadId}`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-configure-presale] Error processing: ${error}`);
    return false;
  }
}