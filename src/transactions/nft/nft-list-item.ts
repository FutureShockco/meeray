import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { MAX_COLLECTION_SUPPLY } from '../../utils/nft.js';
import validate from '../../validation/index.js';
import { NFTTokenData } from './nft-interfaces.js';
import { NFTListingData, NftListPayload } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer } from './nft-transfer.js';
import { generateListingId } from './nft-helpers.js';


export async function validateTx(data: NftListPayload, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.collectionSymbol || !data.instanceId || !data.price || !data.paymentToken) {
            logger.warn('[nft-list-item] Invalid data: Missing required fields (collectionSymbol, instanceId, price, paymentToken).');
            return { valid: false, error: 'missing required fields' };
        }

        const listingType = data.listingType || 'FIXED_PRICE';

        if (listingType === 'AUCTION' || listingType === 'RESERVE_AUCTION') {
            if (!data.auctionEndTime) {
                logger.warn('[nft-list-item] Auction listings require auctionEndTime.');
                return { valid: false, error: 'invalid auction end time' };
            }

            const endTime = new Date(data.auctionEndTime);
            if (isNaN(endTime.getTime()) || endTime <= new Date()) {
                logger.warn('[nft-list-item] Invalid auctionEndTime: must be a valid future date.');
                return { valid: false, error: 'reserve price invalid' };
            }

            // Validate minimum auction duration (e.g., at least 1 hour)
            const minDuration = 60 * 60 * 1000; // 1 hour in milliseconds
            if (endTime.getTime() - Date.now() < minDuration) {
                logger.warn('[nft-list-item] Auction duration too short: minimum 1 hour required.');
                return { valid: false, error: 'minimum bid increment invalid' };
            }
        }

        if (listingType === 'RESERVE_AUCTION') {
            if (!data.reservePrice) {
                logger.warn('[nft-list-item] Reserve auctions require reservePrice.');
                return { valid: false, error: 'missing reserve price' };
            }

            const reservePriceBigInt = toBigInt(data.reservePrice);
            const startingPriceBigInt = toBigInt(data.price);

            if (reservePriceBigInt <= toBigInt(0)) {
                logger.warn('[nft-list-item] Reserve price must be positive.');
                return { valid: false, error: 'invalid reserve price' };
            }

            if (reservePriceBigInt < startingPriceBigInt) {
                logger.warn('[nft-list-item] Reserve price cannot be lower than starting price.');
                return { valid: false, error: 'invalid reserve price' };
            }
        }

        if (data.minimumBidIncrement) {
            const incrementBigInt = toBigInt(data.minimumBidIncrement);
            if (incrementBigInt <= toBigInt(0)) {
                logger.warn('[nft-list-item] Minimum bid increment must be positive.');
                return { valid: false, error: 'invalid minimum bid increment' };
            }
        }

        if (!validate.bigint(data.price, false, false, toBigInt(1))) {
            logger.warn(`[nft-list-item] Invalid price format. Must be a string representing a big integer. Received: ${data.price}`);
            return { valid: false, error: 'invalid price format' };
        }

        if (!validate.string(data.collectionSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[nft-list-item] Invalid collection symbol format: ${data.collectionSymbol}.`);
            return { valid: false, error: 'invalid collection symbol' };
        }
        if (!validate.integer(data.instanceId, false, false, MAX_COLLECTION_SUPPLY, 1)) {
            logger.warn('[nft-list-item] Invalid instanceId length (1-128 chars).');
            return { valid: false, error: 'invalid instance id' };
        }

        if (!await validate.tokenExists(data.paymentToken)) {
            logger.warn(`[nft-list-item] Payment token ${data.paymentToken} does not exist.`);
            return { valid: false, error: 'payment token does not exist' };
        }

        const fullInstanceId = `${data.collectionSymbol}_${data.instanceId}`;
        const nft = (await cache.findOnePromise('nfts', { _id: fullInstanceId })) as NFTTokenData | null;

        if (!nft) {
            logger.warn(`[nft-list-item] NFT ${fullInstanceId} not found.`);
            return { valid: false, error: 'nft not found' };
        }
        if (nft.owner !== sender) {
            logger.warn(`[nft-list-item] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
            return { valid: false, error: 'not nft owner' };
        }

        const collection = (await cache.findOnePromise('nftCollections', {
            _id: data.collectionSymbol,
        })) as CachedNftCollectionForTransfer | null;
        if (!collection) {
            logger.warn(`[nft-list-item] Collection ${data.collectionSymbol} for NFT ${fullInstanceId} not found. Indicates data integrity issue.`);
            return { valid: false, error: 'collection not found' };
        }
        if (collection.transferable === false) {
            logger.warn(`[nft-list-item] NFT Collection ${data.collectionSymbol} does not allow transfer of its NFTs, cannot be listed.`);
            return { valid: false, error: 'collection not transferable' };
        }

        const listingId = generateListingId(data.collectionSymbol, data.instanceId, sender);
        // Check for an existing ACTIVE listing (accept both cases) to prevent duplicates
        const existingListing = (await cache.findOnePromise('nftListings', {
            _id: listingId
        })) as NFTListingData | null;
        if (existingListing && existingListing.status === 'ACTIVE') {
            logger.warn(`[nft-list-item] NFT ${fullInstanceId} is already actively listed by ${sender} under listing ID ${listingId}.`);
            return { valid: false, error: 'already listed' };
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[nft-list-item] Error validating NFT listing payload for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: NftListPayload, sender: string, transactionId: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const fullInstanceId = `${data.collectionSymbol}_${data.instanceId}`;
        const listingId = generateListingId(data.collectionSymbol, data.instanceId, sender);

        const listingDocument: NFTListingData = {
            _id: listingId,
            collectionId: data.collectionSymbol, // Store collectionSymbol as collectionId for consistency
            tokenId: data.instanceId, // Store instanceId as tokenId for consistency
            seller: sender,
            price: toDbString(data.price),
            paymentToken: data.paymentToken,
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            // NEW AUCTION FIELDS:
            listingType: data.listingType || 'FIXED_PRICE',
            reservePrice: data.reservePrice ? toDbString(data.reservePrice) : undefined,
            auctionEndTime: data.auctionEndTime,
            allowBuyNow: data.allowBuyNow || false,
            minimumBidIncrement: data.minimumBidIncrement ? toDbString(data.minimumBidIncrement) : toDbString('100000'), // Default increment
            currentHighestBid: undefined,
            currentHighestBidder: undefined,
            totalBids: 0,
        };

        // Handle re-listing: if a listing doc exists but is not ACTIVE, update it; if not exists, insert.
        const existingAny = (await cache.findOnePromise('nftListings', { _id: listingId })) as NFTListingData | null;
        let listSuccess = false;
        if (existingAny) {
            if (existingAny.status === 'ACTIVE') {
                // Shouldn't happen due to earlier check, but guard anyway
                logger.warn(`[nft-list-item] NFT ${fullInstanceId} is already actively listed by ${sender} under listing ID ${listingId}.`);
                return { valid: false, error: 'already listed' };
            }

            // Update the existing listing to ACTIVE with new fields
            const updatePayload = {
                $set: {
                    ...listingDocument,
                    status: 'ACTIVE',
                    lastUpdatedAt: new Date().toISOString(),
                },
                $unset: { cancelledAt: '' },
            };

            listSuccess = await cache.updateOnePromise('nftListings', { _id: listingId }, updatePayload as any);
        } else {
            listSuccess = await cache.insertOnePromise('nftListings', listingDocument);
        }

        if (!listSuccess) {
            return { valid: false, error: 'failed to create listing' };
        }

        const listingTypeStr = (data.listingType || 'fixed_price').toLowerCase();
        logger.debug(
            `[nft-list-item] NFT ${data.collectionSymbol}_${data.instanceId} listed by ${sender} as ${listingTypeStr} for ${data.price} ${data.paymentToken}. Listing ID: ${listingId}`
        );

        // Log event
        await logEvent('nft', 'listed', sender, {
            listingId,
            collectionSymbol: data.collectionSymbol,
            instanceId: data.instanceId,
            fullInstanceId: `${data.collectionSymbol}_${data.instanceId}`,
            seller: sender,
            price: toDbString(data.price),
            paymentToken: data.paymentToken,
            listingType: listingTypeStr,
            reservePrice: data.reservePrice ? toDbString(data.reservePrice) : undefined,
            auctionEndTime: data.auctionEndTime,
            allowBuyNow: data.allowBuyNow || false,
            minimumBidIncrement: data.minimumBidIncrement ? toDbString(data.minimumBidIncrement) : toDbString('100000'),
        }, transactionId);

        return { valid: true };
    } catch (error) {
        logger.error(`[nft-list-item] Error processing NFT listing for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
