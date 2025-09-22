import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { NFTMintData, NFTCollectionCreateData } from './nft-interfaces.js';
import { NftInstance } from './nft-transfer.js'; // Import NftInstance type
// We need NFTCollectionCreateData to type the fetched collection document for checks
import config from '../../config.js';
import { logEvent } from '../../utils/event-logger.js';
// event logger removed

// Define a more specific type for what we expect from the nftCollections table
interface CachedNftCollection extends NFTCollectionCreateData {
    _id: string;
    currentSupply: number;
    nextIndex: number;
    creator: string;
    // maxSupply is already optional in NFTCollectionCreateData, will be handled as number | undefined
}

export async function validateTx(data: NFTMintData, sender: string): Promise<boolean> {
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
    
    // Handle maxSupply: convert to number for comparison
    let effectiveMaxSupply: number;
    if (collection.maxSupply === undefined) {
      effectiveMaxSupply = Number.MAX_SAFE_INTEGER;
    } else if (typeof collection.maxSupply === 'string') {
      effectiveMaxSupply = Number(collection.maxSupply);
    } else if (typeof collection.maxSupply === 'bigint') {
      effectiveMaxSupply = Number(collection.maxSupply);
    } else if (typeof collection.maxSupply === 'number') {
      effectiveMaxSupply = collection.maxSupply === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : collection.maxSupply;
    } else {
      effectiveMaxSupply = Number.MAX_SAFE_INTEGER;
    }
    
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

export async function processTx(data: NFTMintData, sender: string, id: string): Promise<boolean> {
  try {
    const collection = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol }) as CachedNftCollection;

    // Use sequential token ID (1, 2, 3...) within collection
    const tokenId = collection.nextIndex.toString(); // Sequential: "1", "2", "3"...
    const nftIndex = collection.nextIndex;
    
    // Create globally unique NFT ID: COLLECTION-TOKENID
    const fullInstanceId = `${data.collectionSymbol}_${tokenId}`;  // e.g., "PUNKS-1", "CATS-1"

    // Check if NFT with this ID already exists (shouldn't happen with sequential indexing, but safety check)
    const existingNft = await cache.findOnePromise('nfts', { _id: fullInstanceId });
    if (existingNft) {
      logger.error(`[nft-mint] NFT with ID ${fullInstanceId} already exists during processing.`);
      return false;
    }

    // Create the NFT instance
    const nftInstance: any = {
      _id: fullInstanceId,                    // "PUNKS-1", "CATS-1" (globally unique)
      collectionSymbol: data.collectionSymbol, // "PUNKS", "CATS"
      tokenId: tokenId,                       // "1", "2", "3" (sequential within collection)
      owner: data.owner,
      index: nftIndex,                        // Numeric index for ordering
    };
    if (data.coverUrl) nftInstance.coverUrl = data.coverUrl as string;
    if (data.properties) nftInstance.properties = data.properties;

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
    await logEvent('nft', 'mint', sender, {
      collectionSymbol: data.collectionSymbol,
      tokenId: tokenId,
      fullInstanceId,
      owner: data.owner,
      index: nftIndex,
      coverUrl: data.coverUrl,
      properties: data.properties
    });

    return true;

  } catch (error) {
    logger.error(`[nft-mint] Error processing NFT mint for ${data.collectionSymbol} by ${sender}: ${error}`);
    return false;
  }
}