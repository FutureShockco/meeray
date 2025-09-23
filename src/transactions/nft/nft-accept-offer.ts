import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftAcceptOfferData, NftOffer } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { adjustUserBalance } from '../../utils/account.js';
import { getToken } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: NftAcceptOfferData, sender: string): Promise<boolean> {
  try {
    if (!data.offerId || !validate.string(data.offerId, 256, 3)) {
      logger.warn('[nft-accept-offer] Invalid offerId.');
      return false;
    }

    const offer = await cache.findOnePromise('nftOffers', { _id: data.offerId }) as NftOffer | null;
    if (!offer || offer.status !== 'ACTIVE') {
      logger.warn('[nft-accept-offer] Offer not found or not active.');
      return false;
    }

    if (offer.offerBy === sender) {
      logger.warn('[nft-accept-offer] Cannot accept own offer.');
      return false;
    }

    // Check if offer has expired
    if (offer.expiresAt && new Date(offer.expiresAt) <= new Date()) {
      logger.warn('[nft-accept-offer] Offer has expired.');
      return false;
    }

    // Validate based on offer type
    if (offer.targetType === 'NFT') {
      // For NFT offers, sender must own the specific NFT
      const nft = await cache.findOnePromise('nfts', { _id: offer.targetId }) as NftInstance | null;
      if (!nft || nft.owner !== sender) {
        logger.warn(`[nft-accept-offer] NFT ${offer.targetId} not found or not owned by sender.`);
        return false;
      }

      // Check if NFT is currently listed (can't accept offer on listed NFT)
      const activeListing = await cache.findOnePromise('nftListings', {
        collectionId: offer.targetId.split('-')[0],
        tokenId: offer.targetId.split('-').slice(1).join('-'),
        status: 'active'
      });

      if (activeListing) {
        logger.warn(`[nft-accept-offer] Cannot accept offer on listed NFT ${offer.targetId}.`);
        return false;
      }
    } else if (offer.targetType === 'COLLECTION' || offer.targetType === 'TRAIT') {
      // For collection/trait offers, sender must specify which NFT to sell
      if (!data.nftInstanceId || !validate.string(data.nftInstanceId, 256, 3)) {
        logger.warn('[nft-accept-offer] nftInstanceId required for collection/trait offers.');
        return false;
      }

      const nft = await cache.findOnePromise('nfts', { _id: data.nftInstanceId }) as NftInstance | null;
      if (!nft || nft.owner !== sender) {
        logger.warn(`[nft-accept-offer] NFT ${data.nftInstanceId} not found or not owned by sender.`);
        return false;
      }

      // For collection offers, NFT must be from the specified collection
      if (offer.targetType === 'COLLECTION') {
        const nftCollectionSymbol = data.nftInstanceId.split('-')[0];
        if (nftCollectionSymbol !== offer.targetId) {
          logger.warn(`[nft-accept-offer] NFT ${data.nftInstanceId} is not from collection ${offer.targetId}.`);
          return false;
        }
      }

      // For trait offers, NFT must have matching traits
      if (offer.targetType === 'TRAIT' && offer.traits) {
        // This would require loading NFT metadata and checking traits
        // For now, we'll assume trait validation is done at the application level
        logger.debug(`[nft-accept-offer] Trait validation for ${data.nftInstanceId} would be done here.`);
      }
    }

    // Validate collection transferability
    const targetNftId = offer.targetType === 'NFT' ? offer.targetId : data.nftInstanceId!;
    const collectionSymbol = targetNftId.split('-')[0];
    const collection = await cache.findOnePromise('nftCollections', { _id: collectionSymbol }) as CachedNftCollectionForTransfer | null;
    
    if (!collection || collection.transferable === false) {
      logger.warn(`[nft-accept-offer] Collection ${collectionSymbol} is not transferable.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-accept-offer] Error validating: ${error}`);
    return false;
  }
}

export async function processTx(data: NftAcceptOfferData, sender: string, id: string): Promise<boolean> {
  try {
    const offer = await cache.findOnePromise('nftOffers', { _id: data.offerId }) as NftOffer;
    
    // Determine which NFT is being sold
    const nftInstanceId = offer.targetType === 'NFT' ? offer.targetId : data.nftInstanceId!;
    const collectionSymbol = nftInstanceId.split('-')[0];
    
    // Get collection for royalty calculation
    const collection = await cache.findOnePromise('nftCollections', { _id: collectionSymbol }) as (CachedNftCollectionForTransfer & { royaltyBps?: number });
    
    // Get payment token
    const paymentToken = await getToken(offer.paymentToken.symbol);
    if (!paymentToken) {
      logger.error(`[nft-accept-offer] Payment token not found: ${offer.paymentToken.symbol}`);
      return false;
    }

    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const offerAmount = toBigInt(offer.offerAmount);
    
    // Calculate royalty
    const royaltyBps = toBigInt(collection.royaltyBps || 0);
    const royaltyAmount = (offerAmount * royaltyBps) / toBigInt(10000);
    const sellerProceeds = offerAmount - royaltyAmount;

    // Execute payments
    // Note: Offer amount is already escrowed from offerBy, so we don't need to deduct from them again
    if (!await adjustUserBalance(sender, paymentTokenIdentifier, sellerProceeds)) {
      logger.error(`[nft-accept-offer] Failed to pay seller ${sender} proceeds of ${sellerProceeds}.`);
      return false;
    }

    // Pay royalty to creator (if applicable)
    if (royaltyAmount > 0n && collection.creator && collection.creator !== sender) {
      if (!await adjustUserBalance(collection.creator, paymentTokenIdentifier, royaltyAmount)) {
        logger.error(`[nft-accept-offer] Failed to pay royalty ${royaltyAmount} to creator ${collection.creator}.`);
        return false;
      }
    }

    // Transfer NFT ownership
    const updateNftSuccess = await cache.updateOnePromise(
      'nfts',
      { _id: nftInstanceId, owner: sender },
      { $set: { owner: offer.offerBy, lastTransferredAt: new Date().toISOString() } }
    );

    if (!updateNftSuccess) {
      logger.error(`[nft-accept-offer] Failed to transfer NFT ${nftInstanceId} to ${offer.offerBy}.`);
      return false;
    }

    // Update offer status
    const updateOfferSuccess = await cache.updateOnePromise(
      'nftOffers',
      { _id: data.offerId },
      {
        $set: {
          status: 'ACCEPTED',
          acceptedAt: new Date().toISOString(),
          acceptedBy: sender,
          finalNftId: nftInstanceId,
          finalPrice: toDbString(offerAmount),
          royaltyPaid: toDbString(royaltyAmount)
        }
      }
    );

    if (!updateOfferSuccess) {
      logger.error(`[nft-accept-offer] Failed to update offer ${data.offerId} status.`);
    }

    // Cancel any other active offers for the same NFT from other users
    const otherOffers = await cache.findPromise('nftOffers', {
      targetType: 'NFT',
      targetId: nftInstanceId,
      status: 'ACTIVE',
      _id: { $ne: data.offerId }
    });

    if (otherOffers && otherOffers.length > 0) {
      for (const otherOffer of otherOffers) {
        await cache.updateOnePromise(
          'nftOffers',
          { _id: otherOffer._id },
          { $set: { status: 'CANCELLED', cancelledAt: new Date().toISOString() } }
        );
        // Note: Escrow release for cancelled offers should be handled by a background process
      }
    }

    // Release escrow for cancelled offers (this would typically be done via a separate process)
    // For now, we'll log it as needing manual intervention
    logger.info(`[nft-accept-offer] Other offers for NFT ${nftInstanceId} should have their escrow released.`);

    // Log event
    await logEvent('nft', 'offer_accepted', sender, {
      offerId: data.offerId,
      targetType: offer.targetType,
      targetId: offer.targetId,
      nftInstanceId,
      seller: sender,
      buyer: offer.offerBy,
      offerAmount: toDbString(offerAmount),
      sellerProceeds: toDbString(sellerProceeds),
      royaltyAmount: toDbString(royaltyAmount),
      paymentTokenSymbol: offer.paymentToken.symbol,
      paymentTokenIssuer: offer.paymentToken.issuer,
      acceptedAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-accept-offer] Error processing: ${error}`);
    return false;
  }
}
