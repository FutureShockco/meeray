import logger from '../logger.js';
import cache from '../cache.js';
import { NftBid, NFTListingData } from '../transactions/nft/nft-market-interfaces.js';
import { toBigInt, toDbString } from './bigint.js';
import { adjustUserBalance } from './account.js';
import crypto from 'crypto';

// Helper to generate a unique bid ID
export function generateBidId(listingId: string, bidder: string, timestamp?: number): string {
  const ts = timestamp || Date.now();
  return crypto.createHash('sha256')
    .update(`${listingId}-${bidder}-${ts}`)
    .digest('hex')
    .substring(0, 16);
}

// Get the current highest bid for a listing
export async function getHighestBid(listingId: string): Promise<NftBid | null> {
  try {
    const bids = await cache.findPromise('nftBids', { 
      listingId, 
      status: 'ACTIVE',
      isHighestBid: true 
    }) as NftBid[] | null;
    
    if (!bids || bids.length === 0) {
      return null;
    }
    
    // Should only be one highest bid, but sort just in case
    const sortedBids = bids.sort((a, b) => {
      const amountA = toBigInt(a.bidAmount);
      const amountB = toBigInt(b.bidAmount);
      return amountA > amountB ? -1 : 1;
    });
    
    return sortedBids[0];
  } catch (error) {
    logger.error(`[bid-utils] Error getting highest bid for ${listingId}: ${error}`);
    return null;
  }
}

// Get all active bids for a listing
export async function getActiveBids(listingId: string): Promise<NftBid[]> {
  try {
    const bids = await cache.findPromise('nftBids', { 
      listingId, 
      status: 'ACTIVE' 
    }) as NftBid[] | null;
    
    if (!bids) return [];
    
    // Sort by bid amount (highest first)
    return bids.sort((a, b) => {
      const amountA = toBigInt(a.bidAmount);
      const amountB = toBigInt(b.bidAmount);
      return amountA > amountB ? -1 : 1;
    });
  } catch (error) {
    logger.error(`[bid-utils] Error getting active bids for ${listingId}: ${error}`);
    return [];
  }
}

// Update bid statuses when a new highest bid is placed
export async function updateBidStatuses(listingId: string, newHighestBidId: string): Promise<boolean> {
  try {
    // Mark all other bids as OUTBID
    // Note: Using updateOnePromise in a loop since updateManyPromise doesn't exist
    // Get all other active bids first
    const otherBids = await cache.findPromise('nftBids', { 
      listingId, 
      status: 'ACTIVE', 
      _id: { $ne: newHighestBidId } 
    }) as any[] | null;
    
    let updateOthersSuccess = true;
    if (otherBids && otherBids.length > 0) {
      for (const bid of otherBids) {
        const success = await cache.updateOnePromise(
          'nftBids',
          { _id: bid._id },
          { 
            $set: { 
              status: 'OUTBID', 
              isHighestBid: false 
            } 
          }
        );
        if (!success) {
          updateOthersSuccess = false;
          break;
        }
      }
    }
    
    // Mark the new highest bid as WINNING
    const updateWinnerSuccess = await cache.updateOnePromise(
      'nftBids',
      { _id: newHighestBidId },
      { 
        $set: { 
          status: 'WINNING', 
          isHighestBid: true 
        } 
      }
    );
    
    return updateOthersSuccess && updateWinnerSuccess;
  } catch (error) {
    logger.error(`[bid-utils] Error updating bid statuses for ${listingId}: ${error}`);
    return false;
  }
}

// Calculate minimum bid amount for a listing
export function calculateMinimumBid(listing: NFTListingData, currentHighestBid?: NftBid): bigint {
  const minimumIncrement = toBigInt(listing.minimumBidIncrement || '100000');
  
  if (currentHighestBid) {
    return toBigInt(currentHighestBid.bidAmount) + minimumIncrement;
  } else {
    // First bid - use starting price
    return toBigInt(listing.price);
  }
}

// Validate bid amount against listing requirements
export function validateBidAmount(
  bidAmount: bigint, 
  listing: NFTListingData, 
  currentHighestBid?: NftBid
): { valid: boolean; reason?: string } {
  
  // Check if auction has ended
  if (listing.auctionEndTime && new Date() > new Date(listing.auctionEndTime)) {
    return { valid: false, reason: 'Auction has ended' };
  }
  
  // Calculate minimum required bid
  const minimumBid = calculateMinimumBid(listing, currentHighestBid);
  
  if (bidAmount < minimumBid) {
    return { 
      valid: false, 
      reason: `Bid amount ${bidAmount} is below minimum required ${minimumBid}` 
    };
  }
  
  // Check reserve price for reserve auctions
  if (listing.listingType === 'RESERVE_AUCTION' && listing.reservePrice) {
    const reservePrice = toBigInt(listing.reservePrice);
    if (bidAmount < reservePrice) {
      return { 
        valid: false, 
        reason: `Bid amount ${bidAmount} is below reserve price ${reservePrice}` 
      };
    }
  }
  
  return { valid: true };
}

// Escrow funds for a bid
export async function escrowBidFunds(
  bidder: string, 
  amount: bigint, 
  paymentTokenIdentifier: string
): Promise<boolean> {
  try {
    const success = await adjustUserBalance(bidder, paymentTokenIdentifier, -amount);
    if (success) {
      logger.debug(`[bid-utils] Escrowed ${amount} ${paymentTokenIdentifier} from ${bidder}`);
    }
    return success;
  } catch (error) {
    logger.error(`[bid-utils] Error escrowing funds for ${bidder}: ${error}`);
    return false;
  }
}

// Release escrowed funds for a bid
export async function releaseEscrowedFunds(
  bidder: string, 
  amount: bigint, 
  paymentTokenIdentifier: string
): Promise<boolean> {
  try {
    const success = await adjustUserBalance(bidder, paymentTokenIdentifier, amount);
    if (success) {
      logger.debug(`[bid-utils] Released ${amount} ${paymentTokenIdentifier} to ${bidder}`);
    }
    return success;
  } catch (error) {
    logger.error(`[bid-utils] Error releasing funds for ${bidder}: ${error}`);
    return false;
  }
}

// Update listing with new highest bid info
export async function updateListingWithBid(
  listingId: string, 
  bidAmount: bigint, 
  bidder: string
): Promise<boolean> {
  try {
    const success = await cache.updateOnePromise(
      'nftListings',
      { _id: listingId },
      { 
        $set: { 
          currentHighestBid: toDbString(bidAmount),
          currentHighestBidder: bidder,
          lastUpdatedAt: new Date().toISOString()
        },
        $inc: { totalBids: 1 }
      }
    );
    
    return success;
  } catch (error) {
    logger.error(`[bid-utils] Error updating listing ${listingId} with bid: ${error}`);
    return false;
  }
}
