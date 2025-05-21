import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { NftMintData, NftCreateCollectionData } from './nft-interfaces.js';
// We need NftCreateCollectionData to type the fetched collection document for checks
import crypto from 'crypto'; // For UUID generation

// Helper to generate a UUID. Node.js built-in.
function generateUUID(): string {
    return crypto.randomUUID();
}

// Define a more specific type for what we expect from the nftCollections table
interface CachedNftCollection extends NftCreateCollectionData {
    _id: string;
    currentSupply: number;
    creator: string;
    // maxSupply is already optional in NftCreateCollectionData, will be handled as number | undefined
}

export async function validateTx(data: NftMintData, sender: string): Promise<boolean> {
  try {
    if (!data.collectionSymbol || !data.owner) {
      logger.warn('[nft-mint] Invalid data: Missing required fields (collectionSymbol, owner).');
      return false;
    }

    // Validate collectionSymbol format (consistency with create-collection)
    if (!validate.string(data.collectionSymbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[nft-mint] Invalid collection symbol format: ${data.collectionSymbol}.`);
      return false;
    }
    // Validate owner account name format 
    if (!validate.string(data.owner, 16, 3)) { 
      logger.warn(`[nft-mint] Invalid owner account name format: ${data.owner}.`);
      return false;
    }
    if (data.instanceId !== undefined && !validate.string(data.instanceId, 128, 1)) { // Max 128 for instanceId
        logger.warn('[nft-mint] Invalid instanceId length if provided (1-128 chars).');
        return false;
    }
    if (data.uri !== undefined && (!validate.string(data.uri, 2048, 10) || !(data.uri.startsWith('http') || data.uri.startsWith('ipfs://')))) {
        logger.warn('[nft-mint] Invalid uri: incorrect format, or length (10-2048 chars), must start with http or ipfs://.');
        return false;
    }
    if (data.properties !== undefined && typeof data.properties !== 'object') {
        logger.warn('[nft-mint] Properties, if provided, must be an object.');
        return false;
    }

    const collectionFromCache = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol });
    
    if (!collectionFromCache) {
      logger.warn(`[nft-mint] Collection ${data.collectionSymbol} not found.`);
      return false;
    }
    // Type assertion after null check
    const collection = collectionFromCache as CachedNftCollection;

    if (!collection.mintable) {
      logger.warn(`[nft-mint] Collection ${data.collectionSymbol} is not mintable.`);
      return false;
    }
    
    // Handle maxSupply: if undefined or 0 in interface, it was stored as Number.MAX_SAFE_INTEGER or actual value
    const effectiveMaxSupply = collection.maxSupply === undefined || collection.maxSupply === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : collection.maxSupply;
    if (collection.currentSupply >= effectiveMaxSupply && effectiveMaxSupply !== Number.MAX_SAFE_INTEGER) {
      logger.warn(`[nft-mint] Collection ${data.collectionSymbol} has reached its max supply of ${effectiveMaxSupply}.`);
      return false;
    }

    // Sender must be the collection creator to mint (typical initial model, can be changed by roles/permissions later)
    if (collection.creator !== sender) {
        logger.warn(`[nft-mint] Sender ${sender} is not the creator of collection ${data.collectionSymbol}. Only creator can mint.`);
        return false;
    }

    // If instanceId is provided, check its uniqueness within the collection
    if (data.instanceId) {
      const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
      const existingNft = await cache.findOnePromise('nfts', { _id: fullInstanceId });
      if (existingNft) {
        logger.warn(`[nft-mint] NFT with instanceId ${data.instanceId} (full ID: ${fullInstanceId}) already exists in collection ${data.collectionSymbol}.`);
        return false;
      }
    }

    const ownerAccount = await cache.findOnePromise('accounts', { name: data.owner });
    if (!ownerAccount) {
      logger.warn(`[nft-mint] Owner account ${data.owner} not found.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-mint] Error validating data for collection ${data.collectionSymbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftMintData, sender: string): Promise<boolean> {
  try {
    const actualInstanceId = data.instanceId || generateUUID();
    const fullInstanceId = `${data.collectionSymbol}-${actualInstanceId}`;

    // Re-check uniqueness for generated UUID just in case of an extremely rare collision or if validation was skipped/changed.
    // This is a safeguard; for UUIDs, collisions are astronomically unlikely.
    if (!data.instanceId) { // Only re-check if it was auto-generated
        const existingNft = await cache.findOnePromise('nfts', { _id: fullInstanceId });
        if (existingNft) {
            logger.error(`[nft-mint] CRITICAL: Generated instanceId ${actualInstanceId} (full ID: ${fullInstanceId}) collided for collection ${data.collectionSymbol}. Retrying may be an option or use a different generation scheme.`);
            return false; // Critical failure, likely needs investigation
        }
    }

    const nftDocument = {
      _id: fullInstanceId, // Composite ID: collectionSymbol-instanceId
      collectionSymbol: data.collectionSymbol,
      instanceId: actualInstanceId,
      owner: data.owner,
      minter: sender, // The account that executed the mint transaction (collection creator in this model)
      mintedAt: new Date().toISOString(),
      properties: data.properties || {},
      uri: data.uri || null,
      // immutableProperties: data.immutableProperties === undefined ? false : data.immutableProperties, // If added to interface
    };


    const createNftSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nfts', nftDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-mint] Failed to insert NFT ${fullInstanceId} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!createNftSuccess) {
      return false;
    }

    // Increment currentSupply in the collection
    const collectionUpdateSuccess = await cache.updateOnePromise(
      'nftCollections',
      { _id: data.collectionSymbol }, 
      { $inc: { currentSupply: 1 } }
    );

    if (!collectionUpdateSuccess) {
      logger.error(`[nft-mint] CRITICAL: Failed to update currentSupply for collection ${data.collectionSymbol} after minting ${fullInstanceId}. NFT created but collection supply incorrect.`);
      // This is a critical inconsistency. May need manual reconciliation or a rollback of NFT creation.
      // For now, we log and the NFT is minted, but supply is off.
      // await cache.deleteOnePromise('nfts', { _id: fullInstanceId }); // Example of a rollback attempt (needs deleteOnePromise)
    }

    logger.info(`[nft-mint] NFT ${fullInstanceId} minted successfully into collection ${data.collectionSymbol} by ${sender} for owner ${data.owner}.`);

    const eventDocument = {
      type: 'nftMint',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { ...nftDocument }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[nft-mint] CRITICAL: Failed to log nftMint event for ${fullInstanceId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[nft-mint] Error processing mint for collection ${data.collectionSymbol} by ${sender}: ${error}`);
    return false;
  }
} 