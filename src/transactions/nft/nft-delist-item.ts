import cache from '../../cache.js';
import logger from '../../logger.js';
import { toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { NFTListingData, NftDelistPayload } from './nft-market-interfaces.js';

export async function validateTx(data: NftDelistPayload, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.listingId) {
            logger.warn('[nft-delist-item] Invalid data: Missing required field (listingId).');
            return { valid: false, error: 'missing listingId' };
        }
        if (!validate.string(data.listingId, 256, 3)) {
            // Assuming listingId has a reasonable length constraint
            logger.warn(`[nft-delist-item] Invalid listingId format or length: ${data.listingId}.`);
            return { valid: false, error: 'invalid listingId format' };
        }

        const listing = (await cache.findOnePromise('nftListings', { _id: data.listingId })) as NFTListingData | null;

        if (!listing) {
            logger.warn(`[nft-delist-item] Listing with ID ${data.listingId} not found.`);
            return { valid: false, error: 'listing not found' };
        }

        if (listing.seller !== sender) {
            logger.warn(`[nft-delist-item] Sender ${sender} is not the seller of listing ${data.listingId}. Seller: ${listing.seller}.`);
            return { valid: false, error: 'not listing seller' };
        }

        if (listing.status !== 'ACTIVE') {
            logger.warn(`[nft-delist-item] Listing ${data.listingId} is not active. Current status: ${listing.status}.`);
            return { valid: false, error: 'listing not active' };
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[nft-delist-item] Error validating NFT delist payload for listing ${data.listingId} by ${sender}: ${error}`);
    return { valid: false, error: 'item not found or not owned by sender' };
    }
}

export async function processTx(data: NftDelistPayload, sender: string, _id: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const listing = (await cache.findOnePromise('nftListings', { _id: data.listingId })) as NFTListingData;

        const updateSuccess = await cache.updateOnePromise(
            'nftListings',
            { _id: data.listingId },
            { $set: { status: 'CANCELLED', cancelledAt: new Date().toISOString() } }
        );

        if (!updateSuccess) {
            logger.error(`[nft-delist-item] Failed to update listing ${data.listingId} to cancelled status.`);
            return { valid: false, error: 'failed to update listing' };
        }

        // Log event
        await logEvent('nft', 'delisted', sender, {
            listingId: data.listingId,
            seller: sender,
            collectionId: listing.collectionId,
            tokenId: listing.tokenId,
            fullInstanceId: `${listing.collectionId}_${listing.tokenId}`,
            price: toDbString(listing.price),
            paymentToken: listing.paymentToken,
            listingType: listing.listingType,
            cancelledAt: new Date().toISOString(),
        });

        logger.debug(`[nft-delist-item] Listing ${data.listingId} successfully delisted by ${sender}.`);
        return { valid: true };
    } catch (error) {
        logger.error(`[nft-delist-item] Error processing NFT delist for listing ${data.listingId} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
