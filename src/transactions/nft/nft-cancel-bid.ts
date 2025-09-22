import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftCancelBidData, NftBid } from './nft-market-interfaces.js';
import { getToken } from '../../utils/token.js';
import { toBigInt } from '../../utils/bigint.js';
import { releaseEscrowedFunds } from '../../utils/bid.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: NftCancelBidData, sender: string): Promise<boolean> {
  try {
    if (!data.bidId || !data.listingId || !validate.string(data.bidId, 256, 3) || !validate.string(data.listingId, 256, 3)) {
      logger.warn('[nft-cancel-bid] Invalid bidId or listingId.');
      return false;
    }

    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid | null;
    if (!bid || bid.bidder !== sender || bid.listingId !== data.listingId) {
      logger.warn('[nft-cancel-bid] Bid not found or not owned by sender.');
      return false;
    }

    if (bid.status !== 'ACTIVE' && bid.status !== 'WINNING' && bid.status !== 'OUTBID') {
      logger.warn(`[nft-cancel-bid] Cannot cancel bid with status ${bid.status}.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-cancel-bid] Error validating: ${error}`);
    return false;
  }
}

export async function processTx(data: NftCancelBidData, sender: string, id: string): Promise<boolean> {
  try {
    const bid = await cache.findOnePromise('nftBids', { _id: data.bidId }) as NftBid;
    
    // Release escrowed funds
    const paymentToken = await getToken(bid.paymentToken.symbol);
    if (!paymentToken) {
      logger.error(`[nft-cancel-bid] Payment token not found: ${bid.paymentToken.symbol}`);
      return false;
    }

    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const escrowAmount = toBigInt(bid.escrowedAmount);

    if (!await releaseEscrowedFunds(sender, escrowAmount, paymentTokenIdentifier)) {
      logger.error(`[nft-cancel-bid] Failed to release escrowed funds for bid ${data.bidId}.`);
      return false;
    }

    // Update bid status to cancelled
    const updateSuccess = await cache.updateOnePromise(
      'nftBids',
      { _id: data.bidId },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date().toISOString(),
          cancelledBy: sender
        }
      }
    );

    if (!updateSuccess) {
      logger.error(`[nft-cancel-bid] Failed to update bid ${data.bidId} status.`);
      return false;
    }

    // If this was the highest bid, update listing to reflect new highest bid
    if (bid.isHighestBid) {
      const remainingBids = await cache.findPromise('nftBids', {
        listingId: data.listingId,
        status: { $in: ['ACTIVE', 'WINNING'] },
        _id: { $ne: data.bidId }
      }) as NftBid[] | null;

      if (remainingBids && remainingBids.length > 0) {
        // Find new highest bid
        const newHighestBid = remainingBids.reduce((highest, current) => {
          return toBigInt(current.bidAmount) > toBigInt(highest.bidAmount) ? current : highest;
        });

        // Update listing with new highest bid
        await cache.updateOnePromise(
          'nftListings',
          { _id: data.listingId },
          {
            $set: {
              currentHighestBid: newHighestBid.bidAmount,
              currentHighestBidder: newHighestBid.bidder,
              lastUpdatedAt: new Date().toISOString()
            },
            $inc: { totalBids: -1 }
          }
        );

        // Update new highest bid status
        await cache.updateOnePromise(
          'nftBids',
          { _id: newHighestBid._id },
          { $set: { isHighestBid: true, status: 'WINNING' } }
        );
      } else {
        // No remaining bids, clear highest bid info
        await cache.updateOnePromise(
          'nftListings',
          { _id: data.listingId },
          {
            $unset: {
              currentHighestBid: '',
              currentHighestBidder: ''
            },
            $set: {
              lastUpdatedAt: new Date().toISOString()
            },
            $inc: { totalBids: -1 }
          }
        );
      }
    }

    // Log event
    await logEvent('nft', 'bid_cancelled', sender, {
      bidId: data.bidId,
      listingId: data.listingId,
      bidder: sender,
      bidAmount: bid.bidAmount,
      escrowReleased: escrowAmount.toString(),
      paymentTokenSymbol: bid.paymentToken.symbol,
      paymentTokenIssuer: bid.paymentToken.issuer,
      cancelledAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-cancel-bid] Error processing: ${error}`);
    return false;
  }
}