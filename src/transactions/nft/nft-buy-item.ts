import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftBuyPayload, NFTListingData, NftBid } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { Account, adjustBalance, getAccount } from '../../utils/account.js';
import { Token, getTokenByIdentifier } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { 
  generateBidId, 
  getHighestBid, 
  updateBidStatuses, 
  validateBidAmount, 
  escrowBidFunds, 
  releaseEscrowedFunds,
  updateListingWithBid 
} from '../../utils/bid.js';

export async function validateTx(data: NftBuyPayload, sender: string): Promise<boolean> {
  try {
    if (!data.listingId) {
      logger.warn('[nft-buy-item] Invalid data: Missing required field (listingId).');
      return false;
    }
    if (!validate.string(data.listingId, 256, 3)) {
        logger.warn(`[nft-buy-item] Invalid listingId format or length: ${data.listingId}.`);
        return false;
    }

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData | null;
    if (!listing) {
      logger.warn(`[nft-buy-item] Listing ${data.listingId} not found.`);
      return false;
    }
    if (listing.status !== 'active') {
      logger.warn(`[nft-buy-item] Listing ${data.listingId} is not active. Status: ${listing.status}.`);
      return false;
    }
    if (listing.seller === sender) {
      logger.warn(`[nft-buy-item] Buyer ${sender} cannot be the seller ${listing.seller}.`);
      return false;
    }

    const paymentToken = await getTokenByIdentifier(listing.paymentToken.symbol, listing.paymentToken.issuer);
    if (!paymentToken) {
        logger.warn(`[nft-buy-item] Payment token ${listing.paymentToken.symbol} for listing ${data.listingId} not found.`);
        return false;
    }

    const buyerAccount = await getAccount(sender);
    if (!buyerAccount) {
      logger.warn(`[nft-buy-item] Buyer account ${sender} not found.`);
      return false;
    }
    
    const paymentTokenIdentifier = `${listing.paymentToken.symbol}${listing.paymentToken.issuer ? '@' + listing.paymentToken.issuer : ''}`;
    const buyerBalance = toBigInt(buyerAccount.balances?.[paymentTokenIdentifier] || 0);
    const listingPrice = toBigInt(listing.price);
    
    // Determine if this is a bid or full purchase
    const bidAmount = data.bidAmount ? toBigInt(data.bidAmount) : listingPrice;
    const isBid = data.bidAmount && bidAmount < listingPrice;
    
    // For auctions, validate bid logic
    if (listing.listingType === 'AUCTION' || listing.listingType === 'RESERVE_AUCTION') {
      if (!data.bidAmount) {
        logger.warn(`[nft-buy-item] Auction listings require explicit bidAmount.`);
        return false;
      }
      
      // Get current highest bid for validation
      const currentHighestBid = await getHighestBid(data.listingId);
      const bidValidation = validateBidAmount(bidAmount, listing, currentHighestBid ?? undefined);
      
      if (!bidValidation.valid) {
        logger.warn(`[nft-buy-item] Invalid bid: ${bidValidation.reason}`);
        return false;
      }
      
      // Check buyer has sufficient balance for bid
      if (buyerBalance < bidAmount) {
        logger.warn(`[nft-buy-item] Buyer ${sender} has insufficient balance for bid. Has ${buyerBalance}, needs ${bidAmount}.`);
        return false;
      }
    } else {
      // Fixed price listing - check for full purchase or offer
      if (isBid) {
        // This is an offer on a fixed price listing
        if (buyerBalance < bidAmount) {
          logger.warn(`[nft-buy-item] Buyer ${sender} has insufficient balance for offer. Has ${buyerBalance}, needs ${bidAmount}.`);
          return false;
        }
      } else {
        // Full price purchase
        if (buyerBalance < listingPrice) {
          logger.warn(`[nft-buy-item] Buyer ${sender} has insufficient balance. Has ${buyerBalance}, needs ${listingPrice}.`);
          return false;
        }
      }
    }

    const fullInstanceId = `${listing.collectionId}-${listing.tokenId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft) {
      logger.warn(`[nft-buy-item] NFT ${fullInstanceId} for listing ${data.listingId} not found in nfts collection.`);
      return false;
    }
    if (nft.owner !== listing.seller) {
      logger.warn(`[nft-buy-item] NFT ${fullInstanceId} owner (${nft.owner}) does not match listing seller (${listing.seller}). Listing might be stale.`);
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as CachedNftCollectionForTransfer | null;
    if (!collection) {
        logger.warn(`[nft-buy-item] Collection ${listing.collectionId} for NFT ${fullInstanceId} not found.`);
        return false;
    }
    if (collection.transferable === false) {
        logger.warn(`[nft-buy-item] NFT Collection ${listing.collectionId} is not transferable.`);
        return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-buy-item] Error validating NFT buy payload for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftBuyPayload, sender: string, id: string): Promise<boolean> {
  const buyer = sender;
  
  try {
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId, status: 'active' }) as NFTListingData; // validateTx ensures existence

    if (listing.seller === buyer) {
        logger.error(`[nft-buy-item] CRITICAL: Buyer ${buyer} is also the seller ${listing.seller}. Validation missed this?`);
        return false;
    }

    // Determine transaction type: immediate purchase or bid
    const bidAmount = data.bidAmount ? toBigInt(data.bidAmount) : toBigInt(listing.price);
    const listingPrice = toBigInt(listing.price);
    const isImmediatePurchase = bidAmount >= listingPrice || 
                               (listing.listingType === 'FIXED_PRICE' && !data.bidAmount);

    if (isImmediatePurchase) {
      // Execute immediate purchase
      return await executeImmediatePurchase(listing, buyer, bidAmount, id);
    } else {
      // Submit bid
      return await submitBid(listing, buyer, bidAmount, id);
    }
  } catch (error) {
    logger.error(`[nft-buy-item] Error in process: ${error}`);
    return false;
  }
}

// Helper function to execute immediate purchase
async function executeImmediatePurchase(listing: NFTListingData, buyer: string, amount: bigint, transactionId: string): Promise<boolean> {
  try {
    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as (CachedNftCollectionForTransfer & { creatorFee?: number }) | null;
    if (!collection || collection.transferable === false) {
      logger.error(`[nft-buy-item] CRITICAL: Collection ${listing.collectionId} not found or not transferable during processing.`);
      return false;
    }
    const creatorFeePercent = toBigInt(collection.creatorFee || 0);

    const paymentToken = await getTokenByIdentifier(listing.paymentToken.symbol, listing.paymentToken.issuer);
    if (!paymentToken) {
        logger.error(`[nft-buy-item] CRITICAL: Payment token ${listing.paymentToken.symbol} not found during processing.`);
        return false;
    }
    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;

    // Calculate fees
    const price = amount; // Use the actual purchase amount (could be higher than listing price)
    const royaltyAmount = (price * creatorFeePercent) / BigInt(100);
    const sellerProceeds = price - royaltyAmount;

    logger.debug(`[nft-buy-item] Processing sale of listing ${listing._id}: Price=${price}, Royalty=${royaltyAmount} (${creatorFeePercent}%), SellerGets=${sellerProceeds} ${paymentToken.symbol}`);

    // 1. Deduct price from buyer
    if (!await adjustBalance(buyer, paymentTokenIdentifier, -price)) {
      logger.error(`[nft-buy-item] Failed to deduct ${price} ${paymentToken.symbol} from buyer ${buyer}.`);
      return false;
    }

    // 2. Add proceeds to seller
    if (!await adjustBalance(listing.seller, paymentTokenIdentifier, sellerProceeds)) {
      logger.error(`[nft-buy-item] Failed to add ${sellerProceeds} ${paymentToken.symbol} to seller ${listing.seller}.`);
      await adjustBalance(buyer, paymentTokenIdentifier, price); // Attempt to refund buyer
      return false;
    }

    // 3. Add royalty to collection creator (if applicable)
    if (royaltyAmount > 0n && collection.creator) {
      if (!await adjustBalance(collection.creator, paymentTokenIdentifier, royaltyAmount)) {
        logger.error(`[nft-buy-item] Failed to add royalty ${royaltyAmount} ${paymentToken.symbol} to creator ${collection.creator}.`);
        await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds); // Revert seller payment
        await adjustBalance(buyer, paymentTokenIdentifier, price); // Refund buyer
        return false;
      }
      logger.debug(`[nft-buy-item] Royalty of ${royaltyAmount} ${paymentToken.symbol} paid to creator ${collection.creator}.`);
    }

    // 4. Transfer NFT ownership
    const fullInstanceId = `${listing.collectionId}-${listing.tokenId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if(!nft || nft.owner !== listing.seller) {
        logger.error(`[nft-buy-item] CRITICAL: NFT ${fullInstanceId} not found or owner changed mid-transaction. Current owner: ${nft?.owner}`);
        // Attempt to revert all fund transfers
        if (royaltyAmount > 0n && collection.creator) await adjustBalance(collection.creator, paymentTokenIdentifier, -royaltyAmount);
        await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
        await adjustBalance(buyer, paymentTokenIdentifier, price);
        return false;
    }

    const updateNftOwnerSuccess = await cache.updateOnePromise(
      'nfts',
      { _id: fullInstanceId, owner: listing.seller }, 
      { $set: { owner: buyer, lastTransferredAt: new Date().toISOString() } }
    );
    if (!updateNftOwnerSuccess) {
      logger.error(`[nft-buy-item] CRITICAL: Failed to update NFT ${fullInstanceId} owner to ${buyer}.`);
      // Attempt to revert all fund transfers
      if (royaltyAmount > 0n && collection.creator) await adjustBalance(collection.creator, paymentTokenIdentifier, -royaltyAmount);
      await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
      await adjustBalance(buyer, paymentTokenIdentifier, price);
      return false;
    }
    logger.debug(`[nft-buy-item] NFT ${fullInstanceId} ownership transferred from ${listing.seller} to ${buyer}.`);

    // 5. Update listing status to SOLD
    const updateListingStatusSuccess = await cache.updateOnePromise(
      'nftListings',
      { _id: listing._id },
      { 
        $set: { 
          status: 'sold', 
          buyer: buyer, 
          soldAt: new Date().toISOString(), 
          finalPrice: toDbString(price),
          royaltyPaid: toDbString(royaltyAmount)
        } 
      }
    );
    if (!updateListingStatusSuccess) {
      logger.error(`[nft-buy-item] CRITICAL: Failed to update listing ${listing._id} status to SOLD.`);
    }

    logger.debug(`[nft-buy-item] NFT Listing ${listing._id} successfully processed for buyer ${buyer}.`);

    return true;

  } catch (error: any) {
    logger.error(`[nft-buy-item] Error in executeImmediatePurchase: ${error.message || error}`, error.stack);
    return false;
  }
}

// Helper function to submit a bid
async function submitBid(listing: NFTListingData, bidder: string, bidAmount: bigint, transactionId: string): Promise<boolean> {
  try {
    const paymentToken = await getTokenByIdentifier(listing.paymentToken.symbol, listing.paymentToken.issuer);
    if (!paymentToken) {
        logger.error(`[nft-buy-item] CRITICAL: Payment token ${listing.paymentToken.symbol} not found during bid processing.`);
        return false;
    }
    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;

    // Generate bid ID
    const bidId = generateBidId(listing._id, bidder);

    // Check if user already has an active bid on this listing
    const existingBid = await cache.findOnePromise('nftBids', { 
      listingId: listing._id, 
      bidder, 
      status: 'ACTIVE' 
    }) as NftBid | null;

    if (existingBid) {
      // Release previous bid escrow
      const previousEscrow = toBigInt(existingBid.escrowedAmount);
      await releaseEscrowedFunds(bidder, previousEscrow, paymentTokenIdentifier);
      
      // Mark previous bid as cancelled
      await cache.updateOnePromise('nftBids', { _id: existingBid._id }, { 
        $set: { status: 'CANCELLED' } 
      });
    }

    // Escrow funds for new bid
    if (!await escrowBidFunds(bidder, bidAmount, paymentTokenIdentifier)) {
      logger.error(`[nft-buy-item] Failed to escrow ${bidAmount} ${paymentToken.symbol} for bid by ${bidder}.`);
      return false;
    }

    // Get current highest bid to determine if this becomes the new highest
    const currentHighestBid = await getHighestBid(listing._id);
    const isHighestBid = !currentHighestBid || bidAmount > toBigInt(currentHighestBid.bidAmount);

    // Create bid document
    const bidDocument: NftBid = {
      _id: bidId,
      listingId: listing._id,
      bidder: bidder,
      bidAmount: toDbString(bidAmount),
      status: isHighestBid ? 'WINNING' : 'ACTIVE',
      paymentToken: {
        symbol: listing.paymentToken.symbol,
        issuer: listing.paymentToken.issuer
      },
      escrowedAmount: toDbString(bidAmount),
      createdAt: new Date().toISOString(),
      isHighestBid: isHighestBid,
      previousHighBidId: currentHighestBid?._id
    };

    // Insert bid
    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftBids', bidDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-buy-item] Failed to insert bid ${bidId} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!insertSuccess) {
      // Rollback escrow
      await releaseEscrowedFunds(bidder, bidAmount, paymentTokenIdentifier);
      return false;
    }

    // Update bid statuses if this is the new highest bid
    if (isHighestBid) {
      await updateBidStatuses(listing._id, bidId);
      await updateListingWithBid(listing._id, bidAmount, bidder);
    }

    logger.debug(`[nft-buy-item] Bid submitted: ${bidAmount} ${paymentToken.symbol} by ${bidder} for listing ${listing._id}. Bid ID: ${bidId}`);

    return true;

  } catch (error: any) {
    logger.error(`[nft-buy-item] Error in submitBid: ${error.message || error}`, error.stack);
    return false;
  }
}
