import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftBuyPayload, NFTListingData, NftBid } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { getToken } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { generateBidId, getHighestBid, validateBidAmount, escrowBidFunds, releaseEscrowedFunds, updateListingWithBid } from '../../utils/bid.js';

export async function validateTx(data: NftBuyPayload, sender: string): Promise<boolean> {
  try {
    if (!data.listingId || !validate.string(data.listingId, 256, 3)) {
      logger.warn('[nft-buy-item] Invalid listingId.');
      return false;
    }

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NFTListingData | null;
    if (!listing || listing.status !== 'active' || listing.seller === sender) {
      logger.warn(`[nft-buy-item] Invalid listing or seller cannot buy own item.`);
      return false;
    }

    const paymentToken = await getToken(listing.paymentToken.symbol);
    if (!paymentToken) {
      logger.warn(`[nft-buy-item] Payment token not found.`);
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
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft || nft.owner !== listing.seller) {
      logger.warn(`[nft-buy-item] NFT not found or owner mismatch.`);
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as CachedNftCollectionForTransfer | null;
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

export async function processTx(data: NftBuyPayload, sender: string, id: string): Promise<boolean> {
  try {
    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId, status: 'active' }) as NFTListingData;
    const bidAmount = data.bidAmount ? toBigInt(data.bidAmount) : toBigInt(listing.price);
    const listingPrice = toBigInt(listing.price);
    const isImmediatePurchase = bidAmount >= listingPrice || (listing.listingType === 'FIXED_PRICE' && !data.bidAmount);

    if (isImmediatePurchase) {
      return await executeImmediatePurchase(listing, sender, bidAmount, id);
    } else {
      return await submitBid(listing, sender, bidAmount, id);
    }
  } catch (error) {
    logger.error(`[nft-buy-item] Error processing: ${error}`);
    return false;
  }
}

async function executeImmediatePurchase(listing: NFTListingData, buyer: string, amount: bigint, transactionId: string): Promise<boolean> {
  try {
    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionId }) as (CachedNftCollectionForTransfer & { royaltyBps?: number });
    const paymentToken = (await getToken(listing.paymentToken.symbol))!;
    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;

    const royaltyBps = toBigInt(collection.royaltyBps || 0);
    const royaltyAmount = (amount * royaltyBps) / toBigInt(10000); // basis points to percentage
    const sellerProceeds = amount - royaltyAmount;

    // Execute transfers
    if (!await adjustUserBalance(buyer, paymentTokenIdentifier, -amount)) return false;
    if (!await adjustUserBalance(listing.seller, paymentTokenIdentifier, sellerProceeds)) return false;
    if (royaltyAmount > 0n && collection.creator) {
      if (!await adjustUserBalance(collection.creator, paymentTokenIdentifier, royaltyAmount)) return false;
    }

    // Transfer NFT
    const fullInstanceId = `${listing.collectionId}_${listing.tokenId}`;
    if (!await cache.updateOnePromise('nfts', { _id: fullInstanceId, owner: listing.seller }, 
      { $set: { owner: buyer, lastTransferredAt: new Date().toISOString() } })) {
      return false;
    }

    // Update listing
    await cache.updateOnePromise('nftListings', { _id: listing._id }, {
      $set: { status: 'sold', buyer, soldAt: new Date().toISOString(), finalPrice: toDbString(amount), royaltyPaid: toDbString(royaltyAmount) }
    });

    // Log event
    await logEvent('nft', 'sold', buyer, {
      listingId: listing._id, collectionId: listing.collectionId, tokenId: listing.tokenId, fullInstanceId,
      seller: listing.seller, buyer, price: toDbString(amount), finalPrice: toDbString(amount),
      paymentTokenSymbol: listing.paymentToken.symbol, paymentTokenIssuer: listing.paymentToken.issuer,
      royaltyAmount: toDbString(royaltyAmount), soldAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-buy-item] Error in purchase: ${error}`);
    return false;
  }
}

async function submitBid(listing: NFTListingData, bidder: string, bidAmount: bigint, transactionId: string): Promise<boolean> {
  try {
    const paymentToken = await getToken(listing.paymentToken.symbol);
    if (!paymentToken) return false;
    
    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const bidId = generateBidId(listing._id, bidder);

    // Handle existing bid
    const existingBid = await cache.findOnePromise('nftBids', { listingId: listing._id, bidder, status: 'ACTIVE' }) as NftBid | null;
    if (existingBid) {
      await releaseEscrowedFunds(bidder, toBigInt(existingBid.escrowedAmount), paymentTokenIdentifier);
      await cache.updateOnePromise('nftBids', { _id: existingBid._id }, { $set: { status: 'CANCELLED' } });
    }

    // Escrow new bid
    if (!await escrowBidFunds(bidder, bidAmount, paymentTokenIdentifier)) return false;

    // Create bid
    const currentHighestBid = await getHighestBid(listing._id);
    const isHighestBid = !currentHighestBid || bidAmount > toBigInt(currentHighestBid.bidAmount);

    const bidDocument: NftBid = {
      _id: bidId, listingId: listing._id, bidder, bidAmount: toDbString(bidAmount),
      status: isHighestBid ? 'WINNING' : 'ACTIVE',
      paymentToken: { symbol: listing.paymentToken.symbol, issuer: listing.paymentToken.issuer },
      escrowedAmount: toDbString(bidAmount), createdAt: new Date().toISOString(),
      isHighestBid, previousHighBidId: currentHighestBid?._id
    };

    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftBids', bidDocument, (err, result) => resolve(!!(result && !err)));
    });

    if (!insertSuccess) {
      await releaseEscrowedFunds(bidder, bidAmount, paymentTokenIdentifier);
      return false;
    }

    if (isHighestBid) {
      await updateListingWithBid(listing._id, bidAmount, bidder);
    }

    // Log event
    await logEvent('nft', 'bid_placed', bidder, {
      listingId: listing._id, bidId, bidder, bidAmount: toDbString(bidAmount),
      paymentTokenSymbol: paymentToken.symbol, paymentTokenIssuer: paymentToken.issuer,
      isHighestBid, previousHighBidId: currentHighestBid?._id
    });

    return true;
  } catch (error) {
    logger.error(`[nft-buy-item] Error in bid: ${error}`);
    return false;
  }
}
