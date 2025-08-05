import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftListPayload, NFTListingData } from './nft-market-interfaces.js';
import { NftInstance } from './nft-transfer.js'; // Assuming NftInstance is exported and suitable
import { CachedNftCollectionForTransfer } from './nft-transfer.js'; // Assuming this is also suitable
import config from '../../config.js';
import { getTokenByIdentifier } from '../../utils/token.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js'; // Import toBigInt and toDbString

// Helper to generate a unique listing ID
function generateListingId(collectionSymbol: string, instanceId: string, seller: string): string {
  return `${collectionSymbol}-${instanceId}-${seller}`;
}

export async function validateTx(data: NftListPayload, sender: string): Promise<boolean> {
  try {
    if (!data.collectionSymbol || !data.instanceId || !data.price || !data.paymentTokenSymbol) {
      logger.warn('[nft-list-item] Invalid data: Missing required fields (collectionSymbol, instanceId, price, paymentTokenSymbol).');
      return false;
    }

    if (!validate.string(data.price, 64, 1) || !/^[1-9]\d*$/.test(data.price)) {
        logger.warn(`[nft-list-item] Invalid price format. Must be a string representing a positive integer. Received: ${data.price}`);
        return false;
    }
    const priceBigInt = toBigInt(data.price);
    if (priceBigInt <= BigInt(0)) {
        logger.warn(`[nft-list-item] Price must be positive. Received: ${data.price}`);
        return false;
    }

    if (!validate.string(data.collectionSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[nft-list-item] Invalid collection symbol format: ${data.collectionSymbol}.`);
      return false;
    }
    if (!validate.string(data.instanceId, 128, 1)) {
        logger.warn('[nft-list-item] Invalid instanceId length (1-128 chars).');
        return false;
    }
    // Validate payment token details
    if (data.paymentTokenSymbol !== config.nativeToken && !data.paymentTokenIssuer) {
        logger.warn(`[nft-list-item] paymentTokenIssuer is required for non-native token ${data.paymentTokenSymbol}.`);
        return false;
    }
    if (data.paymentTokenSymbol !== config.nativeToken && data.paymentTokenIssuer && !validate.string(data.paymentTokenIssuer, 64, 3)) {
        logger.warn(`[nft-list-item] Invalid paymentTokenIssuer format for ${data.paymentTokenSymbol}.`);
        return false;
    }

    const paymentToken = await getTokenByIdentifier(data.paymentTokenSymbol, data.paymentTokenIssuer);
    if (!paymentToken) {
        logger.warn(`[nft-list-item] Payment token ${data.paymentTokenSymbol}${data.paymentTokenIssuer ? '@'+data.paymentTokenIssuer : ''} not found.`);
        return false;
    }

    const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;

    if (!nft) {
      logger.warn(`[nft-list-item] NFT ${fullInstanceId} not found.`);
      return false;
    }
    if (nft.owner !== sender) {
      logger.warn(`[nft-list-item] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol }) as CachedNftCollectionForTransfer | null;
    if (!collection) {
        logger.warn(`[nft-list-item] Collection ${data.collectionSymbol} for NFT ${fullInstanceId} not found. Indicates data integrity issue.`);
        return false;
    }
    if (collection.transferable === false) { // Explicitly check for false
        logger.warn(`[nft-list-item] NFT Collection ${data.collectionSymbol} does not allow transfer of its NFTs, cannot be listed.`);
        return false;
    }

    // Check if this NFT is already actively listed by this sender
    const listingId = generateListingId(data.collectionSymbol, data.instanceId, sender);
    const existingListing = await cache.findOnePromise('nftListings', { _id: listingId, status: 'ACTIVE' }) as NFTListingData | null;
    if (existingListing) {
        logger.warn(`[nft-list-item] NFT ${fullInstanceId} is already actively listed by ${sender} under listing ID ${listingId}.`);
        return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-list-item] Error validating NFT listing payload for ${data.collectionSymbol}-${data.instanceId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftListPayload, sender: string, id: string): Promise<string | null> {
  try {
    const listingId = generateListingId(data.collectionSymbol, data.instanceId, sender);
    const priceAsBigInt = toBigInt(data.price);

    const listingDocument: NFTListingData = {
      _id: listingId,
      collectionId: data.collectionSymbol,
      tokenId: data.instanceId,
      seller: sender,
      price: priceAsBigInt,
      paymentToken: {
        symbol: data.paymentTokenSymbol,
        issuer: data.paymentTokenIssuer
      },
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    const listSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftListings', listingDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-list-item] Failed to insert listing ${listingId} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!listSuccess) {
      return null; // Indicate failure
    }

    logger.debug(`[nft-list-item] NFT ${data.collectionSymbol}-${data.instanceId} listed by ${sender} for ${data.price} ${data.paymentTokenSymbol}. Listing ID: ${listingId}`);

    return listingId; // Return the ID of the created listing

  } catch (error) {
    logger.error(`[nft-list-item] Error processing NFT listing for ${data.collectionSymbol}-${data.instanceId} by ${sender}: ${error}`);
    return null;
  }
}
