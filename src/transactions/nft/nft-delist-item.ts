import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftDelistPayload, NftListing } from './nft-market-interfaces.js';

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

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NftListing | null;

    if (!listing) {
      logger.warn(`[nft-delist-item] Listing with ID ${data.listingId} not found.`);
      return false;
    }

    if (listing.seller !== sender) {
      logger.warn(`[nft-delist-item] Sender ${sender} is not the seller of listing ${data.listingId}. Seller: ${listing.seller}.`);
      return false;
    }

    if (listing.status !== 'ACTIVE') {
      logger.warn(`[nft-delist-item] Listing ${data.listingId} is not active. Current status: ${listing.status}.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-delist-item] Error validating NFT delist payload for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftDelistPayload, sender: string): Promise<boolean> {
  try {
    const updateSuccess = await cache.updateOnePromise(
      'nftListings',
      { _id: data.listingId, seller: sender, status: 'ACTIVE' }, // Ensure it's still active and owned by sender
      { $set: { status: 'CANCELLED', updatedAt: new Date().toISOString() } }
    );

    if (!updateSuccess) {
      logger.error(`[nft-delist-item] Failed to update listing ${data.listingId} to CANCELLED in cache.`);
      // This could happen if the listing was sold or cancelled by another process just before this update.
      // Re-fetch to confirm current state for a more accurate log/error if needed.
      const currentListing = await cache.findOnePromise('nftListings', { _id: data.listingId });
      logger.error(`[nft-delist-item] Current state of listing ${data.listingId}: ${JSON.stringify(currentListing)}`);
      return false;
    }

    logger.debug(`[nft-delist-item] NFT Listing ${data.listingId} cancelled by ${sender}.`);

    // Log event
    const eventDocument = {
      type: 'nftDelistItem',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: { listingId: data.listingId }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[nft-delist-item] CRITICAL: Failed to log nftDelistItem event for ${data.listingId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;
  } catch (error) {
    logger.error(`[nft-delist-item] Error processing NFT delist for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
} 