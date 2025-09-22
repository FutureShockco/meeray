import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftMakeOfferData, NftOffer } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { getToken } from '../../utils/token.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import crypto from 'crypto';

// Helper to generate offer ID
function generateOfferId(targetType: string, targetId: string, offerBy: string, timestamp?: number): string {
  const ts = timestamp || Date.now();
  return crypto.createHash('sha256')
    .update(`${targetType}_${targetId}_${offerBy}_${ts}`)
    .digest('hex')
    .substring(0, 16);
}

export async function validateTx(data: NftMakeOfferData, sender: string): Promise<boolean> {
  try {
    // Validate basic inputs
    if (!data.targetType || !['NFT', 'COLLECTION', 'TRAIT'].includes(data.targetType)) {
      logger.warn('[nft-make-offer] Invalid targetType.');
      return false;
    }

    if (!data.targetId || !validate.string(data.targetId, 256, 3)) {
      logger.warn('[nft-make-offer] Invalid targetId.');
      return false;
    }

    if (!data.offerAmount || !validate.string(data.offerAmount, 64, 1)) {
      logger.warn('[nft-make-offer] Invalid offerAmount.');
      return false;
    }

    if (!data.paymentTokenSymbol || !validate.string(data.paymentTokenSymbol, 64, 1)) {
      logger.warn('[nft-make-offer] Invalid paymentTokenSymbol.');
      return false;
    }

    // Validate payment token
    const paymentToken = await getToken(data.paymentTokenSymbol);
    if (!paymentToken) {
      logger.warn(`[nft-make-offer] Payment token ${data.paymentTokenSymbol}${data.paymentTokenIssuer ? '@'+data.paymentTokenIssuer : ''} not found.`);
      return false;
    }

    // Validate offer amount
    const offerAmount = toBigInt(data.offerAmount);
    if (offerAmount <= 0n) {
      logger.warn('[nft-make-offer] Offer amount must be positive.');
      return false;
    }

    // Check sender balance
    const senderAccount = await getAccount(sender);
    if (!senderAccount) {
      logger.warn(`[nft-make-offer] Sender account ${sender} not found.`);
      return false;
    }

    const paymentTokenIdentifier = `${data.paymentTokenSymbol}${data.paymentTokenIssuer ? '@' + data.paymentTokenIssuer : ''}`;
    const senderBalance = toBigInt(senderAccount.balances?.[paymentTokenIdentifier] || 0);
    
    if (senderBalance < offerAmount) {
      logger.warn('[nft-make-offer] Insufficient balance for offer.');
      return false;
    }

    // Validate target based on type
    if (data.targetType === 'NFT') {
      // For NFT offers, validate the NFT exists
      const nft = await cache.findOnePromise('nfts', { _id: data.targetId }) as NftInstance | null;
      if (!nft) {
        logger.warn(`[nft-make-offer] NFT ${data.targetId} not found.`);
        return false;
      }

      if (nft.owner === sender) {
        logger.warn('[nft-make-offer] Cannot make offer on own NFT.');
        return false;
      }

      // Check if NFT collection is transferable
      const parts = data.targetId.split('-');
      const collectionSymbol = parts[0];
      const collection = await cache.findOnePromise('nftCollections', { _id: collectionSymbol }) as CachedNftCollectionForTransfer | null;
      if (!collection || collection.transferable === false) {
        logger.warn(`[nft-make-offer] Collection ${collectionSymbol} is not transferable.`);
        return false;
      }
    } else if (data.targetType === 'COLLECTION') {
      // For collection offers, validate collection exists
      const collection = await cache.findOnePromise('nftCollections', { _id: data.targetId });
      if (!collection) {
        logger.warn(`[nft-make-offer] Collection ${data.targetId} not found.`);
        return false;
      }

      if (collection.transferable === false) {
        logger.warn(`[nft-make-offer] Collection ${data.targetId} is not transferable.`);
        return false;
      }
    } else if (data.targetType === 'TRAIT') {
      // For trait offers, validate collection exists and traits are provided
      if (!data.traits || Object.keys(data.traits).length === 0) {
        logger.warn('[nft-make-offer] Trait offers require traits specification.');
        return false;
      }

      const collection = await cache.findOnePromise('nftCollections', { _id: data.targetId });
      if (!collection) {
        logger.warn(`[nft-make-offer] Collection ${data.targetId} not found for trait offer.`);
        return false;
      }
    }

    // Validate expiration if provided
    if (data.expiresAt) {
      const expirationDate = new Date(data.expiresAt);
      if (expirationDate <= new Date()) {
        logger.warn('[nft-make-offer] Expiration date must be in the future.');
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error(`[nft-make-offer] Error validating: ${error}`);
    return false;
  }
}

export async function processTx(data: NftMakeOfferData, sender: string, id: string): Promise<boolean> {
  try {
    const offerAmount = toBigInt(data.offerAmount);
    const paymentTokenIdentifier = `${data.paymentTokenSymbol}${data.paymentTokenIssuer ? '@' + data.paymentTokenIssuer : ''}`;

    // Cancel any existing active offer from this sender for the same target
    const existingOffer = await cache.findOnePromise('nftOffers', {
      targetType: data.targetType,
      targetId: data.targetId,
      offerBy: sender,
      status: 'ACTIVE'
    }) as NftOffer | null;

    if (existingOffer) {
      // Release escrowed funds from previous offer
      const previousEscrowAmount = toBigInt(existingOffer.escrowedAmount);
      await adjustUserBalance(sender, paymentTokenIdentifier, previousEscrowAmount);
      
      // Cancel the previous offer
      await cache.updateOnePromise(
        'nftOffers',
        { _id: existingOffer._id },
        { $set: { status: 'CANCELLED', cancelledAt: new Date().toISOString() } }
      );
    }

    // Escrow funds for new offer
    if (!await adjustUserBalance(sender, paymentTokenIdentifier, -offerAmount)) {
      logger.error(`[nft-make-offer] Failed to escrow ${offerAmount} ${paymentTokenIdentifier} from ${sender}.`);
      return false;
    }

    // Create offer document
    const offerId = generateOfferId(data.targetType, data.targetId, sender);
    const offerDocument: NftOffer = {
      _id: offerId,
      targetType: data.targetType,
      targetId: data.targetId,
      offerBy: sender,
      offerAmount: toDbString(offerAmount),
      paymentToken: {
        symbol: data.paymentTokenSymbol,
        issuer: data.paymentTokenIssuer
      },
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      escrowedAmount: toDbString(offerAmount)
    };

    // Add optional fields
    if (data.expiresAt) {
      offerDocument.expiresAt = data.expiresAt;
    }

    if (data.traits) {
      offerDocument.traits = data.traits;
    }

    if (data.floorPrice) {
      offerDocument.floorPrice = toDbString(toBigInt(data.floorPrice));
    }

    // Insert offer
    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftOffers', offerDocument, (err, result) => resolve(!!(result && !err)));
    });

    if (!insertSuccess) {
      // Rollback escrow
      await adjustUserBalance(sender, paymentTokenIdentifier, offerAmount);
      logger.error(`[nft-make-offer] Failed to insert offer document.`);
      return false;
    }

    // Log event
    await logEvent('nft', 'offer_made', sender, {
      offerId,
      targetType: data.targetType,
      targetId: data.targetId,
      offerBy: sender,
      offerAmount: toDbString(offerAmount),
      paymentTokenSymbol: data.paymentTokenSymbol,
      paymentTokenIssuer: data.paymentTokenIssuer,
      expiresAt: data.expiresAt,
      traits: data.traits,
      createdAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-make-offer] Error processing: ${error}`);
    return false;
  }
}
