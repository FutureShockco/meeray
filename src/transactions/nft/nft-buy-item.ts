import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftBuyPayload, NftListing } from './nft-market-interfaces.js';
import { NftInstance, CachedNftCollectionForTransfer } from './nft-transfer.js'; // Assuming NftInstance, CachedNftCollectionForTransfer are exported
import { Account, adjustBalance, getAccount } from '../../utils/account-utils.js';
import { Token, getTokenByIdentifier } from '../../utils/token-utils.js';
import config from '../../config.js';
import { BigIntMath } from '../../utils/bigint-utils.js';

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

    const listing = await cache.findOnePromise('nftListings', { _id: data.listingId }) as NftListing | null;
    if (!listing) {
      logger.warn(`[nft-buy-item] Listing ${data.listingId} not found.`);
      return false;
    }
    if (listing.status !== 'ACTIVE') {
      logger.warn(`[nft-buy-item] Listing ${data.listingId} is not active. Status: ${listing.status}.`);
      return false;
    }
    if (listing.seller === sender) {
      logger.warn(`[nft-buy-item] Buyer ${sender} cannot be the seller ${listing.seller}.`);
      return false;
    }

    const paymentToken = await getTokenByIdentifier(listing.paymentTokenSymbol, listing.paymentTokenIssuer);
    if (!paymentToken) {
        logger.warn(`[nft-buy-item] Payment token ${listing.paymentTokenSymbol} for listing ${data.listingId} not found.`);
        return false;
    }

    const buyerAccount = await getAccount(sender);
    if (!buyerAccount) {
      logger.warn(`[nft-buy-item] Buyer account ${sender} not found.`);
      return false;
    }
    
    const paymentTokenIdentifier = `${listing.paymentTokenSymbol}${listing.paymentTokenIssuer ? '@' + listing.paymentTokenIssuer : ''}`;
    const buyerBalance = BigIntMath.toBigInt(buyerAccount.balances?.[paymentTokenIdentifier] || 0);
    const listingPrice = BigIntMath.toBigInt(listing.price);
    
    if (buyerBalance < listingPrice) {
      logger.warn(`[nft-buy-item] Buyer ${sender} has insufficient balance of ${listing.paymentTokenSymbol}. Has ${buyerBalance}, needs ${listingPrice}.`);
      return false;
    }

    const fullInstanceId = `${listing.collectionSymbol}-${listing.instanceId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nft) {
      logger.warn(`[nft-buy-item] NFT ${fullInstanceId} for listing ${data.listingId} not found in nfts collection.`);
      return false;
    }
    if (nft.owner !== listing.seller) {
      logger.warn(`[nft-buy-item] NFT ${fullInstanceId} owner (${nft.owner}) does not match listing seller (${listing.seller}). Listing might be stale.`);
      return false;
    }

    const collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionSymbol }) as CachedNftCollectionForTransfer | null;
    if (!collection) {
        logger.warn(`[nft-buy-item] Collection ${listing.collectionSymbol} for NFT ${fullInstanceId} not found.`);
        return false;
    }
    if (collection.transferable === false) {
        logger.warn(`[nft-buy-item] NFT Collection ${listing.collectionSymbol} is not transferable.`);
        return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-buy-item] Error validating NFT buy payload for listing ${data.listingId} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: NftBuyPayload, buyer: string): Promise<boolean> {
  let listing: NftListing | null = null;
  let collection: (CachedNftCollectionForTransfer & { creatorFee?: number }) | null = null; // Ensure creatorFee is accessible
  let paymentToken: Token | null = null;
  const originalBuyerBalances: { [tokenIdentifier: string]: bigint } = {};
  const originalSellerBalances: { [tokenIdentifier: string]: bigint } = {};
  const originalCreatorBalances: { [tokenIdentifier: string]: bigint } = {};
  let nftOriginalOwner: string | null = null;

  try {
    listing = await cache.findOnePromise('nftListings', { _id: data.listingId, status: 'ACTIVE' }) as NftListing | null;
    if (!listing) {
      logger.error(`[nft-buy-item] CRITICAL: Listing ${data.listingId} not found or not active during processing.`);
      return false;
    }

    if (listing.seller === buyer) {
        logger.error(`[nft-buy-item] CRITICAL: Buyer ${buyer} is also the seller ${listing.seller}. Validation missed this?`);
        return false;
    }

    collection = await cache.findOnePromise('nftCollections', { _id: listing.collectionSymbol }) as (CachedNftCollectionForTransfer & { creatorFee?: number }) | null;
    if (!collection || collection.transferable === false) {
      logger.error(`[nft-buy-item] CRITICAL: Collection ${listing.collectionSymbol} not found or not transferable during processing.`);
      return false;
    }
    const creatorFeePercent = BigIntMath.toBigInt(collection.creatorFee || 0);

    paymentToken = await getTokenByIdentifier(listing.paymentTokenSymbol, listing.paymentTokenIssuer);
    if (!paymentToken) {
        logger.error(`[nft-buy-item] CRITICAL: Payment token ${listing.paymentTokenSymbol} not found during processing.`);
        return false;
    }
    const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`; 
    
    // --- Snapshot balances (simplified, direct object copy might be needed for full rollback simulation) ---
    const buyerAccount = await getAccount(buyer);
    const sellerAccount = await getAccount(listing.seller);
    if(buyerAccount) Object.assign(originalBuyerBalances, buyerAccount.balances);
    if(sellerAccount) Object.assign(originalSellerBalances, sellerAccount.balances);
    if (collection.creator && collection.creator !== listing.seller && creatorFeePercent > 0n) {
        const creatorAccount = await getAccount(collection.creator);
        if(creatorAccount) Object.assign(originalCreatorBalances, creatorAccount.balances);
    }
    // --- End Snapshot ---

    // Calculate fees (ensure precision with BigIntMath)
    const price = BigIntMath.toBigInt(listing.price);
    const royaltyAmount = BigIntMath.div(BigIntMath.mul(price, creatorFeePercent), BigInt(100));
    const sellerProceeds = BigIntMath.sub(price, royaltyAmount);

    logger.debug(`[nft-buy-item] Processing sale of listing ${data.listingId}: Price=${price}, Royalty=${royaltyAmount} (${creatorFeePercent}%), SellerGets=${sellerProceeds} ${paymentToken.symbol}`);

    // 1. Deduct price from buyer
    if (!await adjustBalance(buyer, paymentTokenIdentifier, -price)) {
      logger.error(`[nft-buy-item] Failed to deduct ${price} ${paymentToken.symbol} from buyer ${buyer}.`);
      // TODO: More robust rollback needed here in a real system
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
    const fullInstanceId = `${listing.collectionSymbol}-${listing.instanceId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if(!nft || nft.owner !== listing.seller) {
        logger.error(`[nft-buy-item] CRITICAL: NFT ${fullInstanceId} not found or owner changed mid-transaction. Current owner: ${nft?.owner}`);
        // Attempt to revert all fund transfers
        if (royaltyAmount > 0n && collection.creator) await adjustBalance(collection.creator, paymentTokenIdentifier, -royaltyAmount);
        await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
        await adjustBalance(buyer, paymentTokenIdentifier, price);
        return false;
    }
    nftOriginalOwner = nft.owner; // Should be listing.seller

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
      { _id: data.listingId },
      { 
        $set: { 
          status: 'SOLD', 
          buyer: buyer, 
          soldAt: new Date().toISOString(), 
          finalPrice: price.toString(), 
          royaltyPaid: royaltyAmount.toString() 
        } 
      }
    );
    if (!updateListingStatusSuccess) {
      logger.error(`[nft-buy-item] CRITICAL: Failed to update listing ${data.listingId} status to SOLD. NFT and funds transferred but listing state inconsistent.`);
      // This is a problematic state. The sale happened, but the listing isn't marked correctly.
    }

    logger.debug(`[nft-buy-item] NFT Listing ${data.listingId} successfully processed for buyer ${buyer}.`);

    // Log event
    const eventDocument = {
      _id: Date.now().toString(36),
      type: 'nftBuyItem',
      timestamp: new Date().toISOString(),
      actor: buyer,
      data: { 
        listingId: data.listingId,
        collectionSymbol: listing.collectionSymbol,
        instanceId: listing.instanceId,
        seller: listing.seller,
        buyer: buyer,
        price: price.toString(),
        paymentTokenSymbol: paymentToken.symbol,
        paymentTokenIssuer: paymentToken.issuer,
        royaltyAmount: royaltyAmount.toString(),
        collectionCreator: collection.creator, // if royaltyAmount > 0
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[nft-buy-item] CRITICAL: Failed to log nftBuyItem event for ${data.listingId}: ${err || 'no result'}.`);
            }
            resolve(); 
        });
    });

    return true;

  } catch (error: any) {
    logger.error(`[nft-buy-item] CATASTROPHIC ERROR processing NFT buy for listing ${data.listingId} by ${buyer}: ${error.message || error}`, error.stack);
    // --- Attempt Full Rollback on Catastrophic Error ---
    // This is best-effort and non-atomic, order of operations matters.
    logger.error('[nft-buy-item] Attempting catastrophic error rollback...');
    if (listing && paymentToken) {
        const paymentTokenIdentifier = `${paymentToken.symbol}${paymentToken.issuer ? '@' + paymentToken.issuer : ''}`;
        const price = BigIntMath.toBigInt(listing.price);
        const royaltyAmount = BigIntMath.div(BigIntMath.mul(price, BigIntMath.toBigInt(collection?.creatorFee || 0)), BigInt(100));
        const sellerProceeds = BigIntMath.sub(price, royaltyAmount);

        // Try to revert NFT ownership if it was changed
        if (nftOriginalOwner && listing.collectionSymbol && listing.instanceId) {
            const fullId = `${listing.collectionSymbol}-${listing.instanceId}`;
            logger.warn(`[nft-buy-item-ROLLBACK] Attempting to revert NFT ${fullId} ownership to ${nftOriginalOwner}`);
            await cache.updateOnePromise('nfts', { _id: fullId, owner: buyer }, { $set: { owner: nftOriginalOwner } });
        }
        // Try to revert payments
        if (royaltyAmount > 0n && collection?.creator) {
            logger.warn(`[nft-buy-item-ROLLBACK] Attempting to revert royalty ${royaltyAmount} from ${collection.creator}`);
            await adjustBalance(collection.creator, paymentTokenIdentifier, -royaltyAmount);
        }
        logger.warn(`[nft-buy-item-ROLLBACK] Attempting to revert seller proceeds ${sellerProceeds} from ${listing.seller}`);
        await adjustBalance(listing.seller, paymentTokenIdentifier, -sellerProceeds);
        logger.warn(`[nft-buy-item-ROLLBACK] Attempting to revert price ${price} to buyer ${buyer}`);
        await adjustBalance(buyer, paymentTokenIdentifier, price);
    }
    logger.error('[nft-buy-item] Catastrophic error rollback attempt finished.');
    return false;
  }
} 