import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftAcceptBidData, NftBid, NFTListingData } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { getToken } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { releaseEscrowedFunds } from '../../utils/bid.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: NftAcceptBidData, sender: string): Promise<boolean> {
  try {
    if (!data.bidId || !data.listingId || !validate.string(data.bidId, 256, 3) || !validate.string(data.listingId, 256, 3)) {
      logger.warn('[nft-accept-bid] Invalid bidId or listingId.');
      return false;
    }

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData | null;
    if (!listing || listing.seller !== sender || listing.status !== 'active') {
      logger.warn('[nft-accept-bid] Invalid listing or not seller.');
      return false;
    }

    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid | null;
    if (!bid || bid.listingId !== data.listingId || (bid.status !== 'ACTIVE' && bid.status !== 'WINNING')) {
      logger.warn('[nft-accept-bid] Invalid bid.');
      return false;
    }

    // Check auction end time
    if ((listing.listingType === 'AUCTION' || listing.listingType === 'RESERVE_AUCTION') && listing.auctionEndTime) {
      if (new Date() < new Date(listing.auctionEndTime)) {
        logger.warn('[nft-accept-bid] Cannot accept bid before auction ends.');
        return false;
      }
    }

    // Check reserve price
    if (listing.listingType === 'RESERVE_AUCTION' && listing.reservePrice) {
      if (toBigInt(bid.bidAmount) < toBigInt(listing.reservePrice)) {
        logger.warn('[nft-accept-bid] Bid does not meet reserve price.');
        return false;
      }
    }

    // Validate NFT and collection
    const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft || nft.owner !== listing.seller) {
      logger.warn('[nft-accept-bid] NFT not found or owner mismatch.');
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as CachedNftCollectionForTransfer | null;
    if (!collection || collection.transferable === false) {
      logger.warn('[nft-accept-bid] Collection not transferable.');
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-accept-bid] Error validating: ${error}`);
    return false;
  }
}

export async function processTx(data: NftAcceptBidData, sender: string, id: string): Promise<boolean> {
  try {
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData;
    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid;
    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as (CachedNftCollectionForTransfer & { royaltyBps?: number });
    const paymentToken = (await getToken(listing.paymentToken.symbol))!;

    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const bidAmount = toBigInt(bid.bidAmount);
    const royaltyAmount = (bidAmount * toBigInt(collection.royaltyBps || 0)) / toBigInt(10000); // basis points to percentage
    const sellerProceeds = bidAmount - royaltyAmount;

    // Execute payments
    if (!await adjustUserBalance(listing.seller, paymentTokenIdentifier, sellerProceeds)) return false;
    if (royaltyAmount > 0n && collection.creator && collection.creator !== listing.seller) {
      if (!await adjustUserBalance(collection.creator, paymentTokenIdentifier, royaltyAmount)) return false;
    }

    // Transfer NFT
    const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
    if (!await cache.updateOnePromise('nfts', { _id: fullInstanceId, owner: listing.seller },
      { $set: { owner: bid.bidder, lastTransferredAt: new Date().toISOString() } })) {
      return false;
    }

    // Update listing and bid
    await cache.updateOnePromise('nftListings', { _id: data.listingId }, {
      $set: { status: 'sold', buyer: bid.bidder, soldAt: new Date().toISOString(), 
              finalPrice: toDbString(bidAmount), royaltyPaid: toDbString(royaltyAmount), acceptedBidId: data.bidId }
    });
    await cache.updateOnePromise('nftBids', { _id: data.bidId }, {
      $set: { status: 'WON', acceptedAt: new Date().toISOString() }
    });

    // Release other bids
    const otherBids = await cache.findPromise('nftBids', {
      listingId: data.listingId, _id: { $ne: data.bidId }, status: { $in: ['ACTIVE', 'WINNING', 'OUTBID'] }
    }) as NftBid[] | null;

    if (otherBids?.length) {
      for (const otherBid of otherBids) {
        await releaseEscrowedFunds(otherBid.bidder, toBigInt(otherBid.escrowedAmount), paymentTokenIdentifier);
        await cache.updateOnePromise('nftBids', { _id: otherBid._id }, { $set: { status: 'LOST' } });
      }
    }

    // Log event
    await logEvent('nft', 'bid_accepted', sender, {
      bidId: data.bidId, listingId: data.listingId, collectionId: listing.collectionId, tokenId: listing.tokenId, fullInstanceId,
      seller: listing.seller, buyer: bid.bidder, bidAmount: toDbString(bidAmount), sellerProceeds: toDbString(sellerProceeds),
      royaltyAmount: toDbString(royaltyAmount), paymentTokenSymbol: listing.paymentToken.symbol, paymentTokenIssuer: listing.paymentToken.issuer,
      acceptedAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-accept-bid] Error processing: ${error}`);
    return false;
  }
}
