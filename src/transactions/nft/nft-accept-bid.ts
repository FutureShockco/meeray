import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftAcceptBidData, NftBid, NFTListingData } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { adjustBalance, getAccount } from '../../utils/account.js';
import { getTokenByIdentifier } from '../../utils/token.js';
import { toBigInt } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import { releaseEscrowedFunds } from '../../utils/bid.js';

export async function validateTx(data: NftAcceptBidData, sender: string): Promise<boolean> {
  try {
    if (!data.bidId || !data.listingId) {
      logger.warn('[nft-accept-bid] Invalid data: Missing required fields (bidId, listingId).');
      return false;
    }

    if (!validate.string(data.bidId, 256, 3)) {
      logger.warn(`[nft-accept-bid] Invalid bidId format or length: ${data.bidId}.`);
      return false;
    }

    if (!validate.string(data.listingId, 256, 3)) {
      logger.warn(`[nft-accept-bid] Invalid listingId format or length: ${data.listingId}.`);
      return false;
    }

    // Validate listing exists and sender is the seller
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData | null;
    if (!listing) {
      logger.warn(`[nft-accept-bid] Listing ${data.listingId} not found.`);
      return false;
    }

    if (listing.seller !== sender) {
      logger.warn(`[nft-accept-bid] Sender ${sender} is not the seller of listing ${data.listingId}. Seller: ${listing.seller}.`);
      return false;
    }

    if (listing.status !== 'active') {
      logger.warn(`[nft-accept-bid] Listing ${data.listingId} is not active. Status: ${listing.status}.`);
      return false;
    }

    // Validate bid exists and is active
    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid | null;
    if (!bid) {
      logger.warn(`[nft-accept-bid] Bid ${data.bidId} not found.`);
      return false;
    }

    if (bid.listingId !== data.listingId) {
      logger.warn(`[nft-accept-bid] Bid ${data.bidId} does not belong to listing ${data.listingId}.`);
      return false;
    }

    if (bid.status !== 'ACTIVE' && bid.status !== 'WINNING') {
      logger.warn(`[nft-accept-bid] Bid ${data.bidId} is not active. Status: ${bid.status}.`);
      return false;
    }

    // Check if auction has ended (if applicable)
    if ((listing.listingType === 'AUCTION' || listing.listingType === 'RESERVE_AUCTION') && listing.auctionEndTime) {
      const endTime = new Date(listing.auctionEndTime);
      if (new Date() < endTime) {
        logger.warn(`[nft-accept-bid] Cannot accept bid before auction ends. Auction ends at: ${listing.auctionEndTime}.`);
        return false;
      }
    }

    // Validate reserve price is met (for reserve auctions)
    if (listing.listingType === 'RESERVE_AUCTION' && listing.reservePrice) {
      const bidAmount = toBigInt(bid.bidAmount);
      const reservePrice = toBigInt(listing.reservePrice);
      if (bidAmount < reservePrice) {
        logger.warn(`[nft-accept-bid] Bid amount ${bidAmount} does not meet reserve price ${reservePrice}.`);
        return false;
      }
    }

    // Validate NFT still exists and is owned by seller
    const fullInstanceId = `${listing.collectionId}-${listing.tokenId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft) {
      logger.warn(`[nft-accept-bid] NFT ${fullInstanceId} not found.`);
      return false;
    }

    if (nft.owner !== listing.seller) {
      logger.warn(`[nft-accept-bid] NFT ${fullInstanceId} owner (${nft.owner}) does not match listing seller (${listing.seller}).`);
      return false;
    }

    // Validate collection allows transfers
    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as CachedNftCollectionForTransfer | null;
    if (!collection) {
      logger.warn(`[nft-accept-bid] Collection ${listing.collectionId} not found.`);
      return false;
    }

    if (collection.transferable === false) {
      logger.warn(`[nft-accept-bid] Collection ${listing.collectionId} is not transferable.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-accept-bid] Error validating accept bid for ${data.bidId}: ${error}`);
    return false;
  }
}

export async function process(data: NftAcceptBidData, sender: string, id: string): Promise<boolean> {
  try {
    // Re-fetch data for processing
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData | null;
    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid | null;

    if (!listing || !bid) {
      logger.error(`[nft-accept-bid] CRITICAL: Listing or bid not found during processing.`);
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as (CachedNftCollectionForTransfer & { creatorFee?: number }) | null;
    if (!collection || collection.transferable === false) {
      logger.error(`[nft-accept-bid] CRITICAL: Collection ${listing.collectionId} not found or not transferable.`);
      return false;
    }

    const paymentToken = await getTokenByIdentifier(listing.paymentToken.symbol, listing.paymentToken.issuer);
    if (!paymentToken) {
      logger.error(`[nft-accept-bid] CRITICAL: Payment token ${listing.paymentToken.symbol} not found.`);
      return false;
    }

    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const creatorFeePercent = toBigInt(collection.creatorFee || 0);

    // Calculate payments
    const bidAmount = toBigInt(bid.bidAmount);
    const royaltyAmount = (bidAmount * creatorFeePercent) / BigInt(100);
    const sellerProceeds = bidAmount - royaltyAmount;

    logger.debug(`[nft-accept-bid] Processing bid acceptance: Bid=${bidAmount}, Royalty=${royaltyAmount}, SellerGets=${sellerProceeds}`);

    // 1. Release escrowed funds from bidder and distribute payments
    // The funds are already escrowed, so we need to redirect them rather than deduct again

    // 2. Pay seller their proceeds (funds come from escrow)
    if (!await adjustBalance(listing.seller, paymentTokenIdentifier, sellerProceeds)) {
      logger.error(`[nft-accept-bid] Failed to pay seller ${listing.seller} proceeds of ${sellerProceeds}.`);
      return false;
    }

    // 3. Pay royalty to creator (if applicable)
    if (royaltyAmount > 0n && collection.creator && collection.creator !== listing.seller) {
      if (!await adjustBalance(collection.creator, paymentTokenIdentifier, royaltyAmount)) {
        logger.error(`[nft-accept-bid] Failed to pay royalty ${royaltyAmount} to creator ${collection.creator}.`);
        // Revert seller payment
        await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
        return false;
      }
      logger.debug(`[nft-accept-bid] Royalty of ${royaltyAmount} paid to creator ${collection.creator}.`);
    }

    // 4. The remaining difference between bid amount and payments stays as "platform fee" or gets handled elsewhere
    // For now, we'll account for the full bid amount as spent from escrow
    const totalPaid = sellerProceeds + royaltyAmount;
    const remaining = bidAmount - totalPaid;
    if (remaining > 0n) {
      // This could go to platform fees, or back to the bidder, depending on your business model
      logger.debug(`[nft-accept-bid] Remaining amount after payments: ${remaining}`);
    }

    // 5. Transfer NFT ownership
    const fullInstanceId = `${listing.collectionId}-${listing.tokenId}`;
    const updateNftOwnerSuccess = await cache.updateOnePromise(
      'nfts',
      { _id: fullInstanceId, owner: listing.seller },
      { $set: { owner: bid.bidder, lastTransferredAt: new Date().toISOString() } }
    );

    if (!updateNftOwnerSuccess) {
      logger.error(`[nft-accept-bid] CRITICAL: Failed to update NFT ${fullInstanceId} owner to ${bid.bidder}.`);
      // Revert payments
      if (royaltyAmount > 0n && collection.creator && collection.creator !== listing.seller) {
        await adjustBalance(collection.creator, paymentTokenIdentifier, -royaltyAmount);
      }
      await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
      return false;
    }

    logger.debug(`[nft-accept-bid] NFT ${fullInstanceId} ownership transferred from ${listing.seller} to ${bid.bidder}.`);

    // 6. Update listing status
    const updateListingSuccess = await cache.updateOnePromise(
      'nftListings',
      { _id: data.listingId },
      {
        $set: {
          status: 'sold',
          buyer: bid.bidder,
          soldAt: new Date().toISOString(),
          finalPrice: bidAmount.toString(),
          royaltyPaid: royaltyAmount.toString(),
          acceptedBidId: data.bidId
        }
      }
    );

    if (!updateListingSuccess) {
      logger.error(`[nft-accept-bid] CRITICAL: Failed to update listing ${data.listingId} status.`);
    }

    // 7. Update accepted bid status
    const updateBidSuccess = await cache.updateOnePromise(
      'nftBids',
      { _id: data.bidId },
      {
        $set: {
          status: 'WON',
          acceptedAt: new Date().toISOString()
        }
      }
    );

    if (!updateBidSuccess) {
      logger.error(`[nft-accept-bid] CRITICAL: Failed to update bid ${data.bidId} status.`);
    }

    // 8. Update all other bids for this listing to LOST status and release their escrow
    const otherBids = await cache.findPromise('nftBids', {
      listingId: data.listingId,
      _id: { $ne: data.bidId },
      status: { $in: ['ACTIVE', 'WINNING', 'OUTBID'] }
    }) as NftBid[] | null;

    if (otherBids && otherBids.length > 0) {
      for (const otherBid of otherBids) {
        // Release escrow for losing bids
        const escrowAmount = toBigInt(otherBid.escrowedAmount);
        await releaseEscrowedFunds(otherBid.bidder, escrowAmount, paymentTokenIdentifier);
        
        // Update bid status
        await cache.updateOnePromise(
          'nftBids',
          { _id: otherBid._id },
          { $set: { status: 'LOST' } }
        );
      }
      logger.debug(`[nft-accept-bid] Released escrow for ${otherBids.length} losing bids.`);
    }

    logger.debug(`[nft-accept-bid] Bid ${data.bidId} successfully accepted by ${sender}.`);

    // Log event
    const eventData = {
      listingId: data.listingId,
      bidId: data.bidId,
      collectionSymbol: listing.collectionId,
      instanceId: listing.tokenId,
      seller: listing.seller,
      buyer: bid.bidder,
      finalPrice: bidAmount.toString(),
      paymentTokenSymbol: paymentToken.symbol,
      paymentTokenIssuer: paymentToken.issuer,
      royaltyAmount: royaltyAmount.toString(),
      collectionCreator: collection.creator
    };
    await logTransactionEvent('nftAcceptBid', sender, eventData, id);

    return true;

  } catch (error) {
    logger.error(`[nft-accept-bid] Error processing bid acceptance for ${data.bidId}: ${error}`);
    return false;
  }
}
