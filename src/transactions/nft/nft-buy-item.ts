import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { escrowBidFunds, generateBidId, getHighestBid, releaseEscrowedFunds, updateListingWithBid, validateBidAmount } from '../../utils/bid.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getToken } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { NFTTokenData } from './nft-interfaces.js';
import { NFTListingData, NftBid, NftBuyPayload } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer } from './nft-transfer.js';

export async function validateTx(data: NftBuyPayload, sender: string): Promise<boolean> {
    try {
        if (!validate.string(data.listingId, 256, 3)) {
            logger.warn('[nft-buy-item] Invalid listingId.');
            return false;
        }

        const listing = (await cache.findOnePromise('nftListings', { _id: data.listingId })) as NFTListingData | null;
        if (!listing || listing.status !== 'ACTIVE' || listing.seller === sender) {
            logger.warn(`[nft-buy-item] Invalid listing or seller cannot buy own item.`);
            return false;
        }

        if (!(await validate.tokenExists(listing.paymentToken))) {
            logger.warn(`[nft-buy-item] Payment token ${listing.paymentToken} does not exist.`);
            return false;
        }
        
        const buyerAccount = await getAccount(sender);
        if (!buyerAccount) {
            logger.warn(`[nft-buy-item] Buyer account ${sender} not found.`);
            return false;
        }

        const buyerBalance = toBigInt(buyerAccount.balances?.[listing.paymentToken] || 0);
        const listingPrice = toBigInt(listing.price);
        const bidAmount = data.bidAmount ? toBigInt(data.bidAmount) : listingPrice;

        // For auctions, validate bid logic
        if (listing.listingType === 'AUCTION' || listing.listingType === 'RESERVE_AUCTION') {
            if (!data.bidAmount) {
                logger.warn(`[nft-buy-item] Auction listings require bidAmount.`);
                return false;
            }

            const currentHighestBid = await getHighestBid(data.listingId);
            const bidValidation = validateBidAmount(bidAmount, listing, currentHighestBid ?? undefined);

            if (!bidValidation.valid || buyerBalance < bidAmount) {
                logger.warn(`[nft-buy-item] Invalid bid or insufficient balance.`);
                return false;
            }
        } else if (buyerBalance < bidAmount) {
            logger.warn(`[nft-buy-item] Insufficient balance.`);
            return false;
        }

        const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
        const nft = (await cache.findOnePromise('nfts', { _id: fullInstanceId })) as NFTTokenData | null;
        if (!nft || nft.owner !== listing.seller) {
            logger.warn(`[nft-buy-item] NFT not found or owner mismatch.`);
            return false;
        }

        const collection = (await cache.findOnePromise('nftCollections', {
            _id: listing.collectionId,
        })) as CachedNftCollectionForTransfer | null;
        if (!collection || collection.transferable === false) {
            logger.warn(`[nft-buy-item] Collection not found or not transferable.`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[nft-buy-item] Error validating: ${error}`);
        return false;
    }
}

export async function processTx(data: NftBuyPayload, sender: string, id: string, timestamp: number): Promise<boolean> {
    try {
        const listing = (await cache.findOnePromise('nftListings', {
            _id: data.listingId,
            status: 'active',
        })) as NFTListingData;
        const bidAmount = data.bidAmount ? toBigInt(data.bidAmount) : toBigInt(listing.price);
        const listingPrice = toBigInt(listing.price);
        const isImmediatePurchase = bidAmount >= listingPrice || (listing.listingType === 'FIXED_PRICE' && !data.bidAmount);

        if (isImmediatePurchase) {
            return await executeImmediatePurchase(listing, sender, bidAmount, id);
        } else {
            return await submitBid(listing, sender, bidAmount, id, timestamp);
        }
    } catch (error) {
        logger.error(`[nft-buy-item] Error processing: ${error}`);
        return false;
    }
}

async function executeImmediatePurchase(listing: NFTListingData, buyer: string, amount: bigint, _transactionId: string): Promise<boolean> {
    try {
        const collection = (await cache.findOnePromise('nftCollections', {
            _id: listing.collectionId,
        })) as CachedNftCollectionForTransfer & { royaltyBps?: number };

        const royaltyBps = toBigInt(collection.royaltyBps || 0);
        const royaltyAmount = (amount * royaltyBps) / toBigInt(10000); // basis points to percentage
        const sellerProceeds = amount - royaltyAmount;

        // Execute transfers
        if (!(await adjustUserBalance(buyer, listing.paymentToken, -amount))) return false;
        if (!(await adjustUserBalance(listing.seller, listing.paymentToken, sellerProceeds))) return false;
        if (royaltyAmount > 0n && collection.creator) {
            if (!(await adjustUserBalance(collection.creator, listing.paymentToken, royaltyAmount))) return false;
        }

        // Transfer NFT
        const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
        if (
            !(await cache.updateOnePromise(
                'nfts',
                { _id: fullInstanceId, owner: listing.seller },
                { $set: { owner: buyer, lastTransferredAt: new Date().toISOString() } }
            ))
        ) {
            return false;
        }

        // Update listing
        await cache.updateOnePromise(
            'nftListings',
            { _id: listing._id },
            {
                $set: {
                    status: 'sold',
                    buyer,
                    soldAt: new Date().toISOString(),
                    finalPrice: toDbString(amount),
                    royaltyPaid: toDbString(royaltyAmount),
                },
            }
        );

        // Log event
        await logEvent('nft', 'sold', buyer, {
            listingId: listing._id,
            collectionId: listing.collectionId,
            tokenId: listing.tokenId,
            fullInstanceId,
            seller: listing.seller,
            buyer,
            price: toDbString(amount),
            finalPrice: toDbString(amount),
            paymentToken: listing.paymentToken,
            royaltyAmount: toDbString(royaltyAmount),
            soldAt: new Date().toISOString(),
        });

        return true;
    } catch (error) {
        logger.error(`[nft-buy-item] Error in purchase: ${error}`);
        return false;
    }
}

async function submitBid(listing: NFTListingData, bidder: string, bidAmount: bigint, id: string, timestamp: number): Promise<boolean> {
    try {

        const bidId = generateBidId(listing._id, bidder, timestamp);

        // Handle existing bid
        const existingBid = (await cache.findOnePromise('nftBids', {
            listingId: listing._id,
            bidder,
            status: 'active',
        })) as NftBid | null;
        if (existingBid) {
            await releaseEscrowedFunds(bidder, toBigInt(existingBid.escrowedAmount), listing.paymentToken);
            await cache.updateOnePromise('nftBids', { _id: existingBid._id }, { $set: { status: 'CANCELLED' } });
        }

        // Escrow new bid
        if (!(await escrowBidFunds(bidder, bidAmount, listing.paymentToken))) return false;

        // Create bid
        const currentHighestBid = await getHighestBid(listing._id);
        const isHighestBid = !currentHighestBid || bidAmount > toBigInt(currentHighestBid.bidAmount);

        const bidDocument: NftBid = {
            _id: bidId,
            listingId: listing._id,
            bidder,
            bidAmount: toDbString(bidAmount),
            status: isHighestBid ? 'WINNING' : 'ACTIVE',
            paymentToken: listing.paymentToken,
            escrowedAmount: toDbString(bidAmount),
            createdAt: new Date().toISOString(),
            isHighestBid,
            previousHighBidId: currentHighestBid?._id,
        };

        const insertSuccess = await new Promise<boolean>(resolve => {
            cache.insertOne('nftBids', bidDocument, (err, result) => resolve(!!(result && !err)));
        });

        if (!insertSuccess) {
            await releaseEscrowedFunds(bidder, bidAmount, listing.paymentToken);
            return false;
        }

        if (isHighestBid) {
            await updateListingWithBid(listing._id, bidAmount, bidder);
        }

        // Log event
        await logEvent('nft', 'bid_placed', bidder, {
            listingId: listing._id,
            bidId,
            bidder,
            bidAmount: toDbString(bidAmount),
            paymentToken: listing.paymentToken,
            isHighestBid,
            previousHighBidId: currentHighestBid?._id,
        });

        return true;
    } catch (error) {
        logger.error(`[nft-buy-item] Error in bid: ${error}`);
        return false;
    }
}
