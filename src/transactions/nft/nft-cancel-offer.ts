import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { getToken } from '../../utils/token.js';
import validate from '../../validation/index.js';
import { NftCancelOfferData, NftOffer } from './nft-market-interfaces.js';

export async function validateTx(data: NftCancelOfferData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.offerId || !validate.string(data.offerId, 256, 3)) {
            logger.warn('[nft-cancel-offer] Invalid offerId.');
            return { valid: false, error: 'invalid offerId' };
        }

        const offer = (await cache.findOnePromise('nftOffers', { _id: data.offerId })) as NftOffer | null;
        if (!offer || offer.offerBy !== sender) {
            logger.warn('[nft-cancel-offer] Offer not found or not owned by sender.');
            return { valid: false, error: 'offer not found or not owned' };
        }

        if (offer.status !== 'ACTIVE') {
            logger.warn(`[nft-cancel-offer] Cannot cancel offer with status ${offer.status}.`);
            return { valid: false, error: 'offer not active' };
        }

    return { valid: true };
    } catch (error) {
        logger.error(`[nft-cancel-offer] Error validating: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: NftCancelOfferData, sender: string, _id: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const offer = (await cache.findOnePromise('nftOffers', { _id: data.offerId })) as NftOffer;

        // Release escrowed funds
        const paymentToken = await getToken(offer.paymentToken);
        if (!paymentToken) {
            logger.error(`[nft-cancel-offer] Payment token not found: ${offer.paymentToken}`);
            return { valid: false, error: 'payment token not found' };
        }

        const escrowAmount = toBigInt(offer.escrowedAmount);

        if (!(await adjustUserBalance(sender, paymentToken.symbol, escrowAmount))) {
            logger.error(`[nft-cancel-offer] Failed to release escrowed funds for offer ${data.offerId}.`);
            return { valid: false, error: 'failed to release escrow' };
        }

        // Update offer status to cancelled
        const updateSuccess = await cache.updateOnePromise(
            'nftOffers',
            { _id: data.offerId },
            {
                $set: {
                    status: 'cancelled',
                    cancelledAt: new Date().toISOString(),
                    cancelledBy: sender,
                },
            }
        );

        if (!updateSuccess) {
            logger.error(`[nft-cancel-offer] Failed to update offer ${data.offerId} status.`);
            return { valid: false, error: 'failed to update offer' };
        }

        // Log event
        await logEvent('nft', 'offer_cancelled', sender, {
            offerId: data.offerId,
            targetType: offer.targetType,
            targetId: offer.targetId,
            offerBy: sender,
            offerAmount: offer.offerAmount,
            escrowReleased: escrowAmount.toString(),
            paymentToken: offer.paymentToken,
            cancelledAt: new Date().toISOString(),
        });

    return { valid: true };
    } catch (error) {
        logger.error(`[nft-cancel-offer] Error processing: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
