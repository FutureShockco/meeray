import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { getHighestBid, releaseEscrowedFunds } from '../../utils/bid.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getToken } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { CloseAuctionData, NFTListingData, NftBid } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer } from './nft-transfer.js';

export async function validateTx(data: CloseAuctionData, sender: string): Promise<boolean> {
    try {
        if (!data.listingId) {
            logger.warn('[nft-close-auction] Invalid data: Missing required field (listingId).');
            return false;
        }

        if (!validate.string(data.listingId, 256, 3)) {
            logger.warn(`[nft-close-auction] Invalid listingId format or length: ${data.listingId}.`);
            return false;
        }

        // Validate listing exists
        const listing = (await cache.findOnePromise('nftListings', { _id: data.listingId })) as NFTListingData | null;
        if (!listing) {
            logger.warn(`[nft-close-auction] Listing ${data.listingId} not found.`);
            return false;
        }

        if (listing.status !== 'ACTIVE') {
            logger.warn(`[nft-close-auction] Listing ${data.listingId} is not active. Status: ${listing.status}.`);
            return false;
        }

        // Only auction types can be closed this way
        if (listing.listingType !== 'AUCTION' && listing.listingType !== 'RESERVE_AUCTION') {
            logger.warn(`[nft-close-auction] Listing ${data.listingId} is not an auction. Type: ${listing.listingType}.`);
            return false;
        }

        // Check permissions and timing
        const isOwner = listing.seller === sender;
        const auctionHasEnded = listing.auctionEndTime && new Date() >= new Date(listing.auctionEndTime);

        if (!isOwner && !auctionHasEnded && !data.force) {
            logger.warn('[nft-close-auction] Only seller can close auction before end time.');
            return false;
        }

        // Validate winning bid if provided
        if (data.winningBidId) {
            if (!validate.string(data.winningBidId, 256, 3)) {
                logger.warn('[nft-close-auction] Invalid winningBidId format.');
                return false;
            }

            const winningBid = (await cache.findOnePromise('nftBids', { _id: data.winningBidId })) as NftBid | null;
            if (
                !winningBid ||
                winningBid.listingId !== data.listingId ||
                (winningBid.status !== 'ACTIVE' && winningBid.status !== 'WINNING')
            ) {
                logger.warn('[nft-close-auction] Invalid winning bid.');
                return false;
            }
        }

        // Check reserve price for reserve auctions
        if (listing.listingType === 'RESERVE_AUCTION' && listing.reservePrice) {
            const highestBid = data.winningBidId
                ? ((await cache.findOnePromise('nftBids', { _id: data.winningBidId })) as NftBid | null)
                : await getHighestBid(data.listingId);

            if (!highestBid || toBigInt(highestBid.bidAmount) < toBigInt(listing.reservePrice)) {
                logger.warn('[nft-close-auction] No valid bids or reserve price not met.');
                return false;
            }
        }

        return true;
    } catch (error) {
        logger.error(`[nft-close-auction] Error validating close auction for ${data.listingId}: ${error}`);
        return false;
    }
}

export async function processTx(data: CloseAuctionData, sender: string): Promise<boolean> {
    try {
        // Re-fetch listing for processing
        const listing = (await cache.findOnePromise('nftListings', { _id: data.listingId })) as NFTListingData;

        // Determine winning bid
        let winningBid: NftBid | null = null;

        if (data.winningBidId) {
            winningBid = (await cache.findOnePromise('nftBids', { _id: data.winningBidId })) as NftBid | null;
        } else {
            winningBid = await getHighestBid(data.listingId);
        }

        // Handle case where no bids exist or no qualifying bids
        if (!winningBid) {
            logger.debug(`[nft-close-auction] No winning bid found for auction ${data.listingId}. Ending auction without sale.`);

            // Update listing status to ended
            await cache.updateOnePromise(
                'nftListings',
                { _id: data.listingId },
                { $set: { status: 'ended', endedAt: new Date().toISOString(), endedBy: sender } }
            );

            return true;
        }

        // Process winning bid (similar to accept bid logic)
        const collection = (await cache.findOnePromise('nftCollections', {
            _id: listing.collectionId,
        })) as CachedNftCollectionForTransfer & {
            royaltyBps?: number;
        };
        if (collection.transferable === false) {
            logger.error(`[nft-close-auction] CRITICAL: Collection ${listing.collectionId} not transferable.`);
            return false;
        }

        const paymentToken = (await getToken(listing.paymentToken.symbol))!;

        const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
        const royaltyBps = toBigInt(collection.royaltyBps || 0);

        // Calculate payments
        const bidAmount = toBigInt(winningBid.bidAmount);
        const royaltyAmount = (bidAmount * royaltyBps) / toBigInt(10000); // basis points to percentage
        const sellerProceeds = bidAmount - royaltyAmount;

        logger.debug(
            `[nft-close-auction] Processing auction close: Bid=${bidAmount}, Royalty=${royaltyAmount}, SellerGets=${sellerProceeds}`
        );

        // 1. Pay seller their proceeds
        if (!(await adjustUserBalance(listing.seller, paymentTokenIdentifier, sellerProceeds))) {
            logger.error(`[nft-close-auction] Failed to pay seller ${listing.seller} proceeds of ${sellerProceeds}.`);
            return false;
        }

        // 2. Pay royalty to creator (if applicable)
        if (royaltyAmount > 0n && collection.creator && collection.creator !== listing.seller) {
            if (!(await adjustUserBalance(collection.creator, paymentTokenIdentifier, royaltyAmount))) {
                logger.error(`[nft-close-auction] Failed to pay royalty ${royaltyAmount} to creator ${collection.creator}.`);
                return false;
            }
            logger.debug(`[nft-close-auction] Royalty of ${royaltyAmount} paid to creator ${collection.creator}.`);
        }

        // 3. Transfer NFT ownership
        const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
        const updateNftOwnerSuccess = await cache.updateOnePromise(
            'nfts',
            { _id: fullInstanceId, owner: listing.seller },
            { $set: { owner: winningBid.bidder, lastTransferredAt: new Date().toISOString() } }
        );

        if (!updateNftOwnerSuccess) {
            logger.error(`[nft-close-auction] CRITICAL: Failed to update NFT ${fullInstanceId} owner to ${winningBid.bidder}.`);
            return false;
        }

        logger.debug(
            `[nft-close-auction] NFT ${fullInstanceId} ownership transferred from ${listing.seller} to ${winningBid.bidder}.`
        );

        // 4. Update listing status
        const updateListingSuccess = await cache.updateOnePromise(
            'nftListings',
            { _id: data.listingId },
            {
                $set: {
                    status: 'sold',
                    buyer: winningBid.bidder,
                    soldAt: new Date().toISOString(),
                    finalPrice: toDbString(bidAmount),
                    royaltyPaid: toDbString(royaltyAmount),
                    winningBidId: winningBid._id,
                    endedBy: sender,
                },
            }
        );

        if (!updateListingSuccess) {
            logger.error(`[nft-close-auction] CRITICAL: Failed to update listing ${data.listingId} status.`);
        }

        // 5. Update winning bid status
        const updateWinningBidSuccess = await cache.updateOnePromise(
            'nftBids',
            { _id: winningBid._id },
            { $set: { status: 'won', wonAt: new Date().toISOString() } }
        );

        if (!updateWinningBidSuccess) {
            logger.error(`[nft-close-auction] CRITICAL: Failed to update winning bid ${winningBid._id} status.`);
        }

        // 6. Update all losing bids and release their escrow
        const losingBids = (await cache.findPromise('nftBids', {
            listingId: data.listingId,
            _id: { $ne: winningBid._id },
            status: { $in: ['active', 'winning', 'outbid'] },
        })) as NftBid[] | null;

        if (losingBids && losingBids.length > 0) {
            for (const losingBid of losingBids) {
                // Release escrow for losing bids
                const escrowAmount = toBigInt(losingBid.escrowedAmount);
                await releaseEscrowedFunds(losingBid.bidder, escrowAmount, paymentTokenIdentifier);

                // Update bid status
                await cache.updateOnePromise('nftBids', { _id: losingBid._id }, { $set: { status: 'lost' } });
            }
            logger.debug(`[nft-close-auction] Released escrow for ${losingBids.length} losing bids.`);
        }

        logger.debug(
            `[nft-close-auction] Auction ${data.listingId} successfully closed by ${sender}. Winner: ${winningBid.bidder}.`
        );

        // Log event
        await logEvent('nft', 'auction_closed', sender, {
            listingId: data.listingId,
            collectionId: listing.collectionId,
            tokenId: listing.tokenId,
            fullInstanceId,
            seller: listing.seller,
            winner: winningBid.bidder,
            winningBidId: winningBid._id,
            bidAmount: toDbString(bidAmount),
            sellerProceeds: toDbString(sellerProceeds),
            royaltyAmount: toDbString(royaltyAmount),
            paymentTokenSymbol: listing.paymentToken.symbol,
            paymentTokenIssuer: listing.paymentToken.issuer,
            auctionEndTime: listing.auctionEndTime,
            closedBy: sender,
            closedAt: new Date().toISOString(),
        });

        return true;
    } catch (error) {
        logger.error(`[nft-close-auction] Error processing auction close for ${data.listingId}: ${error}`);
        return false;
    }
}
