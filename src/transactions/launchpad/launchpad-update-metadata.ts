import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { LaunchpadUpdateMetadataData } from './launchpad-interfaces.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: LaunchpadUpdateMetadataData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-update-metadata] Validating metadata update from ${sender} for launchpad ${data.launchpadId}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-update-metadata] Sender must match userId.');
    return false;
  }

  if (!data.launchpadId) {
    logger.warn('[launchpad-update-metadata] Missing required field: launchpadId.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
  if (!launchpad) {
    logger.warn(`[launchpad-update-metadata] Launchpad ${data.launchpadId} not found.`);
    return false;
  }

  if (launchpad.launchedByUserId !== sender) {
    logger.warn(`[launchpad-update-metadata] Only launchpad owner can update metadata.`);
    return false;
  }

  // Validate optional fields if provided
  if (data.tokenDescription && !validate.string(data.tokenDescription, 1000, 0)) {
    logger.warn('[launchpad-update-metadata] tokenDescription too long (max 1000 chars).');
    return false;
  }

  if (data.tokenLogoUrl && (!validate.string(data.tokenLogoUrl, 2048, 10) || !data.tokenLogoUrl.startsWith('http'))) {
    logger.warn('[launchpad-update-metadata] Invalid tokenLogoUrl. Must start with http and be <= 2048 chars.');
    return false;
  }

  if (data.projectSocials) {
    for (const [platform, url] of Object.entries(data.projectSocials)) {
      if (!validate.string(platform, 32, 1)) {
        logger.warn('[launchpad-update-metadata] Invalid projectSocials platform name.');
        return false;
      }
      if (!validate.string(url, 2048, 10) || !url.startsWith('http')) {
        logger.warn('[launchpad-update-metadata] Invalid projectSocials URL.');
        return false;
      }
    }
  }

  logger.debug('[launchpad-update-metadata] Validation passed.');
  return true;
}

export async function processTx(data: LaunchpadUpdateMetadataData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[launchpad-update-metadata] Processing metadata update from ${sender} for ${data.launchpadId}`);
  
  try {
    const now = new Date().toISOString();
    
    // Build update object with only provided fields
    const update: any = {
      updatedAt: now
    };

    if (data.tokenDescription !== undefined) {
      update['tokenToLaunch.description'] = data.tokenDescription;
    }

    if (data.tokenLogoUrl !== undefined) {
      update['tokenToLaunch.logoUrl'] = data.tokenLogoUrl;
    }

    if (data.projectSocials !== undefined) {
      update['tokenToLaunch.socials'] = data.projectSocials;
    }

    const result = await cache.updateOnePromise('launchpads', 
      { _id: data.launchpadId }, 
      { $set: update }
    );

    if (!result) {
      logger.error(`[launchpad-update-metadata] Failed to update launchpad ${data.launchpadId}`);
      return false;
    }

    await logEvent('launchpad', 'metadata_updated', sender, {
      launchpadId: data.launchpadId,
      updatedFields: [
        ...(data.tokenDescription !== undefined ? ['tokenDescription'] : []),
        ...(data.tokenLogoUrl !== undefined ? ['tokenLogoUrl'] : []),
        ...(data.projectSocials !== undefined ? ['projectSocials'] : [])
      ]
    });

    logger.debug(`[launchpad-update-metadata] Metadata updated for ${data.launchpadId}`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-update-metadata] Error processing: ${error}`);
    return false;
  }
}