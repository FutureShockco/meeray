import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftCancelOfferData, NftOffer } from './nft-market-interfaces.js';
import { adjustUserBalance } from '../../utils/account.js';
import { getToken } from '../../utils/token.js';
import { toBigInt } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: NftCancelOfferData, sender: string): Promise<boolean> {
  try {
    if (!data.offerId || !validate.string(data.offerId, 256, 3)) {
      logger.warn('[nft-cancel-offer] Invalid offerId.');
      return false;
    }

    const offer = await cache.findOnePromise('nftOffers', { _id: data.offerId }) as NftOffer | null;
    if (!offer || offer.offerBy !== sender) {
      logger.warn('[nft-cancel-offer] Offer not found or not owned by sender.');
      return false;
    }

    if (offer.status !== 'ACTIVE') {
      logger.warn(`[nft-cancel-offer] Cannot cancel offer with status ${offer.status}.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-cancel-offer] Error validating: ${error}`);
    return false;
  }
}

export async function processTx(data: NftCancelOfferData, sender: string, id: string): Promise<boolean> {
  try {
    const offer = await cache.findOnePromise('nftOffers', { _id: data.offerId }) as NftOffer;
    
    // Release escrowed funds
    const paymentToken = await getToken(offer.paymentToken.symbol);
    if (!paymentToken) {
      logger.error(`[nft-cancel-offer] Payment token not found: ${offer.paymentToken.symbol}`);
      return false;
    }

    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
    const escrowAmount = toBigInt(offer.escrowedAmount);

    if (!await adjustUserBalance(sender, paymentTokenIdentifier, escrowAmount)) {
      logger.error(`[nft-cancel-offer] Failed to release escrowed funds for offer ${data.offerId}.`);
      return false;
    }

    // Update offer status to cancelled
    const updateSuccess = await cache.updateOnePromise(
      'nftOffers',
      { _id: data.offerId },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date().toISOString(),
          cancelledBy: sender
        }
      }
    );

    if (!updateSuccess) {
      logger.error(`[nft-cancel-offer] Failed to update offer ${data.offerId} status.`);
      return false;
    }

    // Log event
    await logEvent('nft', 'offer_cancelled', sender, {
      offerId: data.offerId,
      targetType: offer.targetType,
      targetId: offer.targetId,
      offerBy: sender,
      offerAmount: offer.offerAmount,
      escrowReleased: escrowAmount.toString(),
      paymentTokenSymbol: offer.paymentToken.symbol,
      paymentTokenIssuer: offer.paymentToken.issuer,
      cancelledAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    logger.error(`[nft-cancel-offer] Error processing: ${error}`);
    return false;
  }
}
