import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NFTUpdateMetadataData } from './nft-interfaces.js';
import { NftInstance } from './nft-transfer.js';

export async function validateTx(data: NFTUpdateMetadataData, sender: string): Promise<boolean> {
  try {
    if (!data.collectionSymbol || !data.instanceId) {
      logger.warn('[nft-update] Invalid data: Missing required fields (collectionSymbol, instanceId).');
      return false;
    }

    // Validate collectionSymbol format
    if (!validate.string(data.collectionSymbol, 10, 3)) {
      logger.warn(`[nft-update] Invalid collection symbol format: ${data.collectionSymbol}.`);
      return false;
    }

    // Validate instanceId format
    if (!validate.string(data.instanceId, 128, 1)) {
      logger.warn('[nft-update] Invalid instanceId length (1-128 chars).');
      return false;
    }

    // Validate URI if provided
    if (data.uri !== undefined && (!validate.string(data.uri, 2048, 10) || !(data.uri.startsWith('http') || data.uri.startsWith('ipfs://')))) {
      logger.warn('[nft-update] Invalid uri: incorrect format, or length (10-2048 chars), must start with http or ipfs://.');
      return false;
    }

    // Validate coverUrl if provided
    if (data.coverUrl !== undefined && (!validate.string(data.coverUrl, 2048, 10) || !data.coverUrl.startsWith('http'))) {
      logger.warn('[nft-update] Invalid coverUrl: incorrect format, or length (10-2048 chars), must start with http.');
      return false;
    }

    // Validate properties if provided
    if (data.properties !== undefined && typeof data.properties !== 'object') {
      logger.warn('[nft-update] Properties, if provided, must be an object.');
      return false;
    }

    // Check if NFT exists and sender is the owner
    const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    
    if (!nft) {
      logger.warn(`[nft-update] NFT ${fullInstanceId} not found.`);
      return false;
    }

    if (nft.owner !== sender) {
      logger.warn(`[nft-update] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
      return false;
    }

    // Check if collection exists and is transferable (for validation purposes)
    const collection = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol });
    if (!collection) {
      logger.warn(`[nft-update] Collection ${data.collectionSymbol} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-update] Error validating NFT update for ${data.collectionSymbol}-${data.instanceId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NFTUpdateMetadataData, sender: string, id: string): Promise<boolean> {
  try {
    const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
    
    // Fetch NFT to confirm current owner again before proceeding
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft || nft.owner !== sender) {
      logger.error(`[nft-update] CRITICAL: NFT ${fullInstanceId} not found or sender ${sender} is not owner during processing.`);
      return false;
    }

    // Prepare update object with only provided fields
    const updateFields: any = {
      lastUpdatedAt: new Date().toISOString()
    };

    if (data.properties !== undefined) {
      updateFields.properties = data.properties;
    }

    if (data.uri !== undefined) {
      updateFields.uri = data.uri;
    }

    if (data.coverUrl !== undefined) {
      updateFields.coverUrl = data.coverUrl;
    }

    // Update the NFT
    const updateSuccess = await cache.updateOnePromise(
      'nfts',
      { _id: fullInstanceId, owner: sender }, // Ensure sender is still owner
      { $set: updateFields }
    );

    if (!updateSuccess) {
      logger.error(`[nft-update] Failed to update NFT ${fullInstanceId}.`);
      return false;
    }

    logger.debug(`[nft-update] NFT ${fullInstanceId} successfully updated by ${sender}.`);

    // Log event
    // event logging removed

    return true;
  } catch (error) {
    logger.error(`[nft-update] Error processing NFT update for ${data.collectionSymbol}-${data.instanceId} by ${sender}: ${error}`);
    return false;
  }
} 