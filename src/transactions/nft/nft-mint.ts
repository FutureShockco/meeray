import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { NftMintData, NftCreateCollectionData } from './nft-interfaces.js';
import { NftInstance } from './nft-transfer.js'; // Import NftInstance type
// We need NftCreateCollectionData to type the fetched collection document for checks
import config from '../../config.js';
import { logTransactionEvent } from '../../utils/event-logger.js'; // Import the new event logger

// Define a more specific type for what we expect from the nftCollections table
interface CachedNftCollection extends NftCreateCollectionData {
    _id: string;
    currentSupply: number;
    nextIndex: number;
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
    if (!validate.string(data.collectionSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[nft-mint] Invalid collection symbol format: ${data.collectionSymbol}.`);
      return false;
    }
    // Validate owner account name format 
    if (!validate.string(data.owner, 16, 3)) { 
      logger.warn(`[nft-mint] Invalid owner account name format: ${data.owner}.`);
      return false;
    }

    if (data.uri !== undefined && (!validate.string(data.uri, 2048, 10) || !(data.uri.startsWith('http') || data.uri.startsWith('ipfs://')))) {
        logger.warn('[nft-mint] Invalid uri: incorrect format, or length (10-2048 chars), must start with http or ipfs://.');
        return false;
    }
    if (data.coverUrl !== undefined && (!validate.string(data.coverUrl, 2048, 10) || !data.coverUrl.startsWith('http'))) {
        logger.warn('[nft-mint] Invalid coverUrl: incorrect format, or length (10-2048 chars), must start with http.');
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

export async function process(data: NftMintData, sender: string, id: string): Promise<boolean> {
  try {
    const collection = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol }) as CachedNftCollection | null;
    if (!collection) {
      logger.error(`[nft-mint] Collection ${data.collectionSymbol} not found during processing.`);
      return false;
    }

    if (collection.creator !== sender) {
      logger.error(`[nft-mint] Sender ${sender} is not the creator of collection ${data.collectionSymbol} during processing. Creator: ${collection.creator}.`);
      return false;
    }

    // Use the next sequential index as instanceId
    const actualInstanceId = collection.nextIndex.toString();
    const nftIndex = collection.nextIndex;
    const fullInstanceId = `${data.collectionSymbol}-${actualInstanceId}`;

    // Check if NFT with this ID already exists (shouldn't happen with sequential indexing, but safety check)
    const existingNft = await cache.findOnePromise('nfts', { _id: fullInstanceId });
    if (existingNft) {
      logger.error(`[nft-mint] NFT with ID ${fullInstanceId} already exists during processing.`);
      return false;
    }

    // Create the NFT instance
    const nftInstance: NftInstance = {
      _id: fullInstanceId,
      collectionSymbol: data.collectionSymbol,
      instanceId: actualInstanceId,
      owner: data.owner,
      index: nftIndex,
      coverUrl: data.coverUrl
    };

    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nfts', nftInstance, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-mint] Failed to insert NFT ${fullInstanceId} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!insertSuccess) {
      return false;
    }

    // Update collection's currentSupply and nextIndex
    const updateCollectionSuccess = await cache.updateOnePromise(
      'nftCollections',
      { _id: data.collectionSymbol },
      { $inc: { currentSupply: 1, nextIndex: 1 } }
    );

    if (!updateCollectionSuccess) {
      logger.error(`[nft-mint] Failed to update total supply for collection ${data.collectionSymbol}.`);
      // Consider removing the NFT we just inserted as a rollback
      await cache.deleteOnePromise('nfts', { _id: fullInstanceId });
      return false;
    }

    logger.debug(`[nft-mint] NFT ${fullInstanceId} minted successfully by ${sender} for owner ${data.owner}.`);

    // Log event
    const eventData = { 
      collectionSymbol: data.collectionSymbol,
      instanceId: actualInstanceId,
      index: nftIndex,
      owner: data.owner,
      properties: data.properties,
      uri: data.uri,
      coverUrl: data.coverUrl
    };
    await logTransactionEvent('nftMint', sender, eventData, id);

    return true;

  } catch (error) {
    logger.error(`[nft-mint] Error processing NFT mint for ${data.collectionSymbol} by ${sender}: ${error}`);
    return false;
  }
} 