import crypto from 'crypto';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getToken } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { NftMakeOfferData, NftOffer } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer } from './nft-transfer.js';
import { NFTTokenData } from './nft-interfaces.js';

// Helper to generate offer ID
function generateOfferId(targetType: string, targetId: string, offerBy: string, timestamp?: number): string {
    const ts = timestamp || Date.now();
    return crypto.createHash('sha256').update(`${targetType}_${targetId}_${offerBy}_${ts}`).digest('hex').substring(0, 16);
}

export async function validateTx(data: NftMakeOfferData, sender: string): Promise<boolean> {
    try {
        if (!data.targetType) {
            logger.warn('[nft-make-offer] Invalid targetType.');
            return false;
        }
        const targetType = String(data.targetType).toLowerCase();
        if (!['nft', 'collection', 'trait'].includes(targetType)) {
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

        if (!data.paymentToken || !validate.string(data.paymentToken, 64, 1)) {
            logger.warn('[nft-make-offer] Invalid paymentToken.');
            return false;
        }

        // Validate payment token
        const paymentToken = await getToken(data.paymentToken);
        if (!paymentToken) {
            logger.warn(`[nft-make-offer] Payment token ${data.paymentToken} not found.`);
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

        const senderBalance = toBigInt(senderAccount.balances?.[paymentToken.symbol] || 0);

        if (senderBalance < offerAmount) {
            logger.warn('[nft-make-offer] Insufficient balance for offer.');
            return false;
        }

        // Validate target based on type (use normalized targetType)
        if (targetType === 'nft') {
            // For NFT offers, validate the NFT exists
            const nft = (await cache.findOnePromise('nfts', { _id: data.targetId })) as NFTTokenData | null;
            if (!nft) {
                logger.warn(`[nft-make-offer] NFT ${data.targetId} not found.`);
                return false;
            }

            if (nft.owner === sender) {
                logger.warn('[nft-make-offer] Cannot make offer on own NFT.');
                return false;
            }

            // Check if NFT collection is transferable
            // targetId uses underscore-separated format (collection_instanceId)
            const parts = data.targetId.split('_');
            const collectionSymbol = parts[0];
            const collection = (await cache.findOnePromise('nftCollections', {
                _id: collectionSymbol,
            })) as CachedNftCollectionForTransfer | null;
            if (!collection || collection.transferable === false) {
                logger.warn(`[nft-make-offer] Collection ${collectionSymbol} is not transferable.`);
                return false;
            }
        } else if (targetType === 'collection') {
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
        } else if (targetType === 'trait') {
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

export async function processTx(data: NftMakeOfferData, sender: string, _id: string, timestamp: number): Promise<boolean> {
    try {
        const offerAmount = toBigInt(data.offerAmount);

        // Cancel any existing active offer from this sender for the same target
        const existingOffer = (await cache.findOnePromise('nftOffers', {
            targetType: data.targetType,
            targetId: data.targetId,
            offerBy: sender,
            status: 'active',
        })) as NftOffer | null;

        if (existingOffer) {
            // Release escrowed funds from previous offer
            const previousEscrowAmount = toBigInt(existingOffer.escrowedAmount);
            await adjustUserBalance(sender, existingOffer.paymentToken, previousEscrowAmount);

            // Cancel the previous offer
            await cache.updateOnePromise('nftOffers', { _id: existingOffer._id }, { $set: { status: 'CANCELLED', cancelledAt: new Date().toISOString() } });
        }

        // Escrow funds for new offer
        if (!(await adjustUserBalance(sender, data.paymentToken, -offerAmount))) {
            logger.error(`[nft-make-offer] Failed to escrow ${offerAmount} ${data.paymentToken} from ${sender}.`);
            return false;
        }

        // Create offer document
        const offerId = generateOfferId(data.targetType, data.targetId, sender, timestamp);
        // Normalize stored target type to lowercase to match interfaces
        const storedTargetType = String(data.targetType).toUpperCase() as 'NFT' | 'COLLECTION' | 'TRAIT';
        const offerDocument: NftOffer = {
            _id: offerId,
            targetType: storedTargetType,
            targetId: data.targetId,
            offerBy: sender,
            offerAmount: toDbString(offerAmount),
            paymentToken: data.paymentToken,
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            escrowedAmount: toDbString(offerAmount),
        };

        // Add optional fields
        if (data.expiresAt) {
            offerDocument.expiresAt = data.expiresAt;
        }

        if (data.traits) {
            offerDocument.traits = data.traits;
        }

        if (data.floorPrice) {
            offerDocument.floorPrice = toDbString(data.floorPrice);
        }

        // Insert offer
        const insertSuccess = await new Promise<boolean>(resolve => {
            cache.insertOne('nftOffers', offerDocument, (err, result) => resolve(!!(result && !err)));
        });

        if (!insertSuccess) {
            // Rollback escrow
            await adjustUserBalance(sender, data.paymentToken, offerAmount);
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
            paymentToken: data.paymentToken,
            expiresAt: data.expiresAt,
            traits: data.traits,
            createdAt: new Date().toISOString(),
        });

        return true;
    } catch (error) {
        logger.error(`[nft-make-offer] Error processing: ${error}`);
        return false;
    }
}
