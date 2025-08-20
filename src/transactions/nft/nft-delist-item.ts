import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftDelistPayload, NFTListingData } from './nft-market-interfaces.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';

export async function validateTx(data: NftDelistPayload, sender: string): Promise<boolean> {
  try {
    if (!data.listingId) {
      logger.warn('[nft-delist-item] Invalid data: Missing required field (listingId).');
      return false;
    }
    if (!validate.string(data.listingId, 256, 3)) { // Assuming listingId has a reasonable length constraint
        logger.warn(`[nft-delist-item] Invalid listingId format or length: ${data.listingId}.`);
        return false;
    }

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as    NFTListingData | null;

    if (!listing) {
      logger.warn(`[nft-delist-item] Listing with ID ${data.listingId} not found.`);
      return false;
    }

    if (listing.seller !== sender) {
      logger.warn(`[nft-delist-item] Sender ${sender} is not the seller of listing ${data.listingId}. Seller: ${listing.seller}.`);
      return false;
    }

    if (listing.status !== 'active') {
      logger.warn(`[nft-delist-item] Listing ${data.listingId} is not active. Current status: ${listing.status}.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-delist-item] Error validating NFT delist payload for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftDelistPayload, sender: string, id: string): Promise<boolean> {
  try {
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData;

    const updateSuccess = await cache.updateOnePromise(
      'nftListings',
      { _id: data.listingId },
      { $set: { status: 'cancelled', cancelledAt: new Date().toISOString() } }
    );

    if (!updateSuccess) {
      logger.error(`[nft-delist-item] Failed to update listing ${data.listingId} to cancelled status.`);
      return false;
    }

    // Log event
    await logTransactionEvent('nft_delisted', sender, {
      listingId: data.listingId,
      seller: sender,
      collectionId: listing.collectionId,
      tokenId: listing.tokenId,
      fullInstanceId: `${listing.collectionId}-${listing.tokenId}`,
      price: toDbString(toBigInt(listing.price)),
      paymentTokenSymbol: listing.paymentToken.symbol,
      paymentTokenIssuer: listing.paymentToken.issuer,
      listingType: listing.listingType,
      cancelledAt: new Date().toISOString()
    });

    logger.debug(`[nft-delist-item] Listing ${data.listingId} successfully delisted by ${sender}.`);
    return true;

  } catch (error) {
    logger.error(`[nft-delist-item] Error processing NFT delist for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
} 