import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NFTUpdateCollectionData } from './nft-interfaces.js';

export async function validateTx(data: NFTUpdateCollectionData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol) {
      logger.warn('[nft-update-collection] Invalid data: Missing required field (symbol).');
      return false;
    }

    // Validate symbol format
    if (!validate.string(data.symbol, 10, 3)) {
      logger.warn(`[nft-update-collection] Invalid symbol format: ${data.symbol}.`);
      return false;
    }

    // Validate name if provided
    if (data.name !== undefined && !validate.string(data.name, 50, 1)) {
      logger.warn('[nft-update-collection] Invalid name length (must be 1-50 characters).');
      return false;
    }

    // Validate description if provided
    if (data.description !== undefined && !validate.string(data.description, 1000, 0)) {
      logger.warn('[nft-update-collection] Invalid description length (must be 0-1000 chars).');
      return false;
    }

    // Validate logoUrl if provided
    if (data.logoUrl !== undefined && (!validate.string(data.logoUrl, 2048, 10) || !data.logoUrl.startsWith('http'))) {
      logger.warn('[nft-update-collection] Invalid logoUrl: incorrect format, or length (10-2048 chars).');
      return false;
    }

    // Validate websiteUrl if provided
    if (data.websiteUrl !== undefined && (!validate.string(data.websiteUrl, 2048, 10) || !data.websiteUrl.startsWith('http'))) {
      logger.warn('[nft-update-collection] Invalid websiteUrl: incorrect format, or length (10-2048 chars).');
      return false;
    }

    // Validate baseCoverUrl if provided
    if (data.baseCoverUrl !== undefined && (!validate.string(data.baseCoverUrl, 2048, 10) || !data.baseCoverUrl.startsWith('http'))) {
      logger.warn('[nft-update-collection] Invalid baseCoverUrl: incorrect format, or length (10-2048 chars).');
      return false;
    }

    // Validate creatorFee if provided
    if (data.creatorFee !== undefined) {
      if (!validate.integer(data.creatorFee, true, false, 25, 0)) {
        logger.warn(`[nft-update-collection] Invalid creatorFee: ${data.creatorFee}. Must be an integer between 0 and 25 (inclusive).`);
        return false;
      }
    }

    // Check if collection exists and sender is the creator
    const collection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
    if (!collection) {
      logger.warn(`[nft-update-collection] Collection ${data.symbol} not found.`);
      return false;
    }

    if (collection.creator !== sender) {
      logger.warn(`[nft-update-collection] Sender ${sender} is not the creator of collection ${data.symbol}. Only creator can update.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-update-collection] Error validating collection update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NFTUpdateCollectionData, sender: string, id: string): Promise<boolean> {
  try {
    // Fetch collection to confirm current creator again before proceeding
    const collection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
    if (!collection || collection.creator !== sender) {
      logger.error(`[nft-update-collection] CRITICAL: Collection ${data.symbol} not found or sender ${sender} is not creator during processing.`);
      return false;
    }

    // Prepare update object with only provided fields
    const updateFields: any = {
      lastUpdatedAt: new Date().toISOString()
    };

    if (data.name !== undefined) {
      updateFields.name = data.name;
    }

    if (data.description !== undefined) {
      updateFields.description = data.description;
    }

    if (data.logoUrl !== undefined) {
      updateFields.logoUrl = data.logoUrl;
    }

    if (data.websiteUrl !== undefined) {
      updateFields.websiteUrl = data.websiteUrl;
    }

    if (data.baseCoverUrl !== undefined) {
      updateFields.baseCoverUrl = data.baseCoverUrl;
    }

    if (data.mintable !== undefined) {
      updateFields.mintable = data.mintable;
    }

    if (data.burnable !== undefined) {
      updateFields.burnable = data.burnable;
    }

    if (data.transferable !== undefined) {
      updateFields.transferable = data.transferable;
    }

    if (data.creatorFee !== undefined) {
      updateFields.creatorFee = data.creatorFee;
    }

    // Update the collection
    const updateSuccess = await cache.updateOnePromise(
      'nftCollections',
      { _id: data.symbol, creator: sender }, // Ensure sender is still creator
      { $set: updateFields }
    );

    if (!updateSuccess) {
      logger.error(`[nft-update-collection] Failed to update collection ${data.symbol}.`);
      return false;
    }

    logger.debug(`[nft-update-collection] Collection ${data.symbol} successfully updated by ${sender}.`);

    // Log event
    // event logging removed

    return true;
  } catch (error) {
    logger.error(`[nft-update-collection] Error processing collection update for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 