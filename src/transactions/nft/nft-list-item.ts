import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { MAX_COLLECTION_SUPPLY } from '../../utils/nft.js';
import validate from '../../validation/index.js';
import { NFTListingData, NftListPayload } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer, NftInstance } from './nft-transfer.js';

// Helper to generate a unique listing ID
function generateListingId(collectionSymbol: string, instanceId: string, seller: string): string {
    return `${collectionSymbol}_${instanceId}_${seller}`;
}

export async function validateTx(data: NftListPayload, sender: string): Promise<boolean> {
    try {
        if (!data.collectionSymbol || !data.instanceId || !data.price || !data.paymentToken) {
            logger.warn('[nft-list-item] Invalid data: Missing required fields (collectionSymbol, instanceId, price, paymentToken).');
            return false;
        }

        const listingType = data.listingType || 'FIXED_PRICE';

        if (listingType === 'AUCTION' || listingType === 'RESERVE_AUCTION') {
            if (!data.auctionEndTime) {
                logger.warn('[nft-list-item] Auction listings require auctionEndTime.');
                return false;
            }

            const endTime = new Date(data.auctionEndTime);
            if (isNaN(endTime.getTime()) || endTime <= new Date()) {
                logger.warn('[nft-list-item] Invalid auctionEndTime: must be a valid future date.');
                return false;
            }

            // Validate minimum auction duration (e.g., at least 1 hour)
            const minDuration = 60 * 60 * 1000; // 1 hour in milliseconds
            if (endTime.getTime() - Date.now() < minDuration) {
                logger.warn('[nft-list-item] Auction duration too short: minimum 1 hour required.');
                return false;
            }
        }

        if (listingType === 'RESERVE_AUCTION') {
            if (!data.reservePrice) {
                logger.warn('[nft-list-item] Reserve auctions require reservePrice.');
                return false;
            }

            const reservePriceBigInt = toBigInt(data.reservePrice);
            const startingPriceBigInt = toBigInt(data.price);

            if (reservePriceBigInt <= toBigInt(0)) {
                logger.warn('[nft-list-item] Reserve price must be positive.');
                return false;
            }

            if (reservePriceBigInt < startingPriceBigInt) {
                logger.warn('[nft-list-item] Reserve price cannot be lower than starting price.');
                return false;
            }
        }

        if (data.minimumBidIncrement) {
            const incrementBigInt = toBigInt(data.minimumBidIncrement);
            if (incrementBigInt <= toBigInt(0)) {
                logger.warn('[nft-list-item] Minimum bid increment must be positive.');
                return false;
            }
        }

        if (!validate.bigint(data.price, false, false, toBigInt(config.maxValue), toBigInt(1))) {
            logger.warn(`[nft-list-item] Invalid price format. Must be a string representing a positive integer. Received: ${data.price}`);
            return false;
        }

        const priceBigInt = toBigInt(data.price);
        if (priceBigInt <= toBigInt(0)) {
            logger.warn(`[nft-list-item] Price must be positive. Received: ${data.price}`);
            return false;
        }

        if (!validate.string(data.collectionSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[nft-list-item] Invalid collection symbol format: ${data.collectionSymbol}.`);
            return false;
        }
        if (!validate.integer(data.instanceId, false, false, MAX_COLLECTION_SUPPLY, 1)) {
            logger.warn('[nft-list-item] Invalid instanceId length (1-128 chars).');
            return false;
        }

        if (!await validate.tokenExists(data.paymentToken)) {
            logger.warn(`[nft-list-item] Payment token ${data.paymentToken} does not exist.`);
            return false;
        }

        const fullInstanceId = `${data.collectionSymbol}_${data.instanceId}`;
        const nft = (await cache.findOnePromise('nfts', { _id: fullInstanceId })) as NftInstance | null;

        if (!nft) {
            logger.warn(`[nft-list-item] NFT ${fullInstanceId} not found.`);
            return false;
        }
        if (nft.owner !== sender) {
            logger.warn(`[nft-list-item] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
            return false;
        }

        const collection = (await cache.findOnePromise('nftCollections', {
            _id: data.collectionSymbol,
        })) as CachedNftCollectionForTransfer | null;
        if (!collection) {
            logger.warn(`[nft-list-item] Collection ${data.collectionSymbol} for NFT ${fullInstanceId} not found. Indicates data integrity issue.`);
            return false;
        }
        if (collection.transferable === false) {
            logger.warn(`[nft-list-item] NFT Collection ${data.collectionSymbol} does not allow transfer of its NFTs, cannot be listed.`);
            return false;
        }

        const listingId = generateListingId(data.collectionSymbol, data.instanceId, sender);
        const existingListing = (await cache.findOnePromise('nftListings', {
            _id: listingId,
            status: 'active',
        })) as NFTListingData | null;
        if (existingListing) {
            logger.warn(`[nft-list-item] NFT ${fullInstanceId} is already actively listed by ${sender} under listing ID ${listingId}.`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[nft-list-item] Error validating NFT listing payload for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: NftListPayload, sender: string, _id: string): Promise<string | null> {
    try {
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

        const listSuccess = await new Promise<boolean>(resolve => {
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
        });

        return listingId; // Return the ID of the created listing
    } catch (error) {
        logger.error(`[nft-list-item] Error processing NFT listing for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return null;
    }
}
