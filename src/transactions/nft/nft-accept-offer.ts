import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getToken } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { NFTTokenData } from './nft-interfaces.js';
import { NftAcceptOfferData, NftOffer } from './nft-market-interfaces.js';
import { CachedNftCollectionForTransfer } from './nft-transfer.js';

export async function validateTx(data: NftAcceptOfferData, sender: string): Promise<boolean> {
    try {
        if (!data.offerId || !validate.string(data.offerId, 256, 3)) {
            logger.warn('[nft-accept-offer] Invalid offerId.');
            return false;
        }
        const offer = (await cache.findOnePromise('nftOffers', { _id: data.offerId })) as NftOffer | null;
        if (!offer || offer.status !== 'ACTIVE') {
            logger.warn('[nft-accept-offer] Offer not found or not active.');
            return false;
        }
        if (offer.offerBy === sender) {
            logger.warn('[nft-accept-offer] Cannot accept own offer.');
            return false;
        }
        if (offer.expiresAt && new Date(offer.expiresAt) <= new Date()) {
            logger.warn('[nft-accept-offer] Offer has expired.');
            return false;
        }
        if (offer.targetType === 'NFT') {
            const nft = (await cache.findOnePromise('nfts', { _id: offer.targetId })) as NFTTokenData | null;
            if (!nft || nft.owner !== sender) {
                logger.warn(`[nft-accept-offer] NFT ${offer.targetId} not found or not owned by sender.`);
                return false;
            }
            const parts = offer.targetId.split('_');
            const activeListing = await cache.findOnePromise('nftListings', {
                collectionId: parts[0],
                tokenId: parts.slice(1).join('_'),
                status: 'active',
            });
            if (activeListing) {
                logger.warn(`[nft-accept-offer] Cannot accept offer on listed NFT ${offer.targetId}.`);
                return false;
            }
        } else if (offer.targetType === 'COLLECTION' || offer.targetType === 'TRAIT') {
            if (!data.nftInstanceId || !validate.string(data.nftInstanceId, 256, 3)) {
                logger.warn('[nft-accept-offer] nftInstanceId required for collection/trait offers.');
                return false;
            }
            const nft = (await cache.findOnePromise('nfts', { _id: data.nftInstanceId })) as NFTTokenData | null;
            if (!nft || nft.owner !== sender) {
                logger.warn(`[nft-accept-offer] NFT ${data.nftInstanceId} not found or not owned by sender.`);
                return false;
            }
            if (offer.targetType === 'COLLECTION') {
                const nftCollectionSymbol = data.nftInstanceId.split('_')[0];
                if (nftCollectionSymbol !== offer.targetId) {
                    logger.warn(`[nft-accept-offer] NFT ${data.nftInstanceId} is not from collection ${offer.targetId}.`);
                    return false;
                }
            }
            if (offer.targetType === 'TRAIT' && offer.traits) {
                logger.debug(`[nft-accept-offer] Trait validation for ${data.nftInstanceId} would be done here.`);
            }
        }
        const targetNftId = offer.targetType === 'NFT' ? offer.targetId : data.nftInstanceId!;
        const collectionSymbol = targetNftId.split('_')[0];
        const collection = (await cache.findOnePromise('nftCollections', {
            _id: collectionSymbol,
        })) as CachedNftCollectionForTransfer | null;
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

export async function processTx(data: NftAcceptOfferData, sender: string, _id: string): Promise<boolean> {
    try {
        const offer = (await cache.findOnePromise('nftOffers', { _id: data.offerId })) as NftOffer;
        const nftInstanceId = offer.targetType === 'NFT' ? offer.targetId : data.nftInstanceId!;
        const collectionSymbol = nftInstanceId.split('_')[0];
        const collection = (await cache.findOnePromise('nftCollections', {
            _id: collectionSymbol,
        })) as CachedNftCollectionForTransfer & { royaltyBps?: number };

        const paymentToken = await getToken(offer.paymentToken);
        if (!paymentToken) {
            logger.error(`[nft-accept-offer] Payment token not found: ${offer.paymentToken}`);
            return false;
        }
        const offerAmount = toBigInt(offer.offerAmount);
        const royaltyBps = toBigInt(collection.royaltyBps || 0);
        const royaltyAmount = (offerAmount * royaltyBps) / toBigInt(10000);
        const sellerProceeds = offerAmount - royaltyAmount;
        if (!(await adjustUserBalance(sender, paymentToken.symbol, sellerProceeds))) {
            logger.error(`[nft-accept-offer] Failed to pay seller ${sender} proceeds of ${sellerProceeds}.`);
            return false;
        }
        if (royaltyAmount > 0n && collection.creator && collection.creator !== sender) {
            if (!(await adjustUserBalance(collection.creator, paymentToken.symbol, royaltyAmount))) {
                logger.error(`[nft-accept-offer] Failed to pay royalty ${royaltyAmount} to creator ${collection.creator}.`);
                return false;
            }
        }
        const updateNftSuccess = await cache.updateOnePromise(
            'nfts',
            { _id: nftInstanceId, owner: sender },
            { $set: { owner: offer.offerBy, lastTransferredAt: new Date().toISOString() } }
        );
        if (!updateNftSuccess) {
            logger.error(`[nft-accept-offer] Failed to transfer NFT ${nftInstanceId} to ${offer.offerBy}.`);
            return false;
        }
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
                    royaltyPaid: toDbString(royaltyAmount),
                },
            }
        );
        if (!updateOfferSuccess) {
            logger.error(`[nft-accept-offer] Failed to update offer ${data.offerId} status.`);
        }
        const otherOffers = await cache.findPromise('nftOffers', {
            targetType: 'NFT',
            targetId: nftInstanceId,
            status: 'active',
            _id: { $ne: data.offerId },
        });
        if (otherOffers && otherOffers.length > 0) {
            for (const otherOffer of otherOffers) {
                await cache.updateOnePromise('nftOffers', { _id: otherOffer._id }, { $set: { status: 'CANCELLED', cancelledAt: new Date().toISOString() } });
            }
        }
        logger.info(`[nft-accept-offer] Other offers for NFT ${nftInstanceId} should have their escrow released.`);
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
            paymentToken: offer.paymentToken,
            acceptedAt: new Date().toISOString(),
        });
        return true;
    } catch (error) {
        logger.error(`[nft-accept-offer] Error processing: ${error}`);
        return false;
    }
}
