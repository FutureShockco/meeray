import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js'; // For BURN_ACCOUNT_NAME eventually
import { NftTransferData, NftCreateCollectionData } from './nft-interfaces.js';

// TODO: Replace 'null' with config.burnAccountName || 'null' once burnAccountName is added to config type and value
const BURN_ACCOUNT_NAME = 'null';

// Define a more specific type for what we expect from the nftCollections table for these checks
export interface CachedNftCollectionForTransfer extends NftCreateCollectionData {
    _id: string;
    // burnable & transferable are already in NftCreateCollectionData
}

// Define a type for the NFT instance document from the 'nfts' table
export interface NftInstance {
    _id: string; // collectionSymbol-instanceId
    collectionSymbol: string;
    instanceId: string;
    owner: string;
    // other fields like minter, mintedAt, properties, uri exist but aren't strictly needed for transfer logic itself
}

export async function validateTx(data: NftTransferData, sender: string): Promise<boolean> {
  try {
    if (!data.collectionSymbol || !data.instanceId || !data.to) {
      logger.warn('[nft-transfer/burn] Invalid data: Missing required fields (collectionSymbol, instanceId, to).');
      return false;
    }

    // Validate formats
    if (!validate.string(data.collectionSymbol, 10, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) {
      logger.warn(`[nft-transfer/burn] Invalid collection symbol format: ${data.collectionSymbol}.`);
      return false;
    }
    if (!validate.string(data.instanceId, 128, 1)) { // Max 128 for instanceId
        logger.warn('[nft-transfer/burn] Invalid instanceId length (1-128 chars).');
        return false;
    }
    if (data.to !== BURN_ACCOUNT_NAME && !validate.string(data.to, 16, 3)) {
      logger.warn(`[nft-transfer/burn] Invalid recipient account name format: ${data.to}.`);
      return false;
    }
    if (data.memo && typeof data.memo === 'string' && !validate.string(data.memo, 256, 1)) {
        logger.warn('[nft-transfer/burn] Invalid memo: Exceeds maximum length of 256 chars.');
        return false;
    }
    if (data.memo && typeof data.memo !== 'string') {
        logger.warn('[nft-transfer/burn] Invalid memo: Must be a string if provided.');
        return false;
    }

    const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
    const nft = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;

    if (!nft) {
      logger.warn(`[nft-transfer/burn] NFT ${fullInstanceId} not found.`);
      return false;
    }
    if (nft.owner !== sender) {
      logger.warn(`[nft-transfer/burn] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
      return false;
    }

    const collectionFromCache = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol });
    if (!collectionFromCache) {
        logger.warn(`[nft-transfer/burn] Collection ${data.collectionSymbol} for NFT ${fullInstanceId} not found. This indicates a data integrity issue.`);
        return false; // Should not happen if NFT exists
    }
    const collection = collectionFromCache as CachedNftCollectionForTransfer;

    if (data.to === BURN_ACCOUNT_NAME) {
      // Burning NFT
      if (collection.burnable === false) { // Explicitly check for false, as undefined defaults to true
        logger.warn(`[nft-transfer/burn] NFT Collection ${data.collectionSymbol} does not allow burning of its NFTs.`);
        return false;
      }
    } else {
      // Regular Transfer
      if (sender === data.to) {
        logger.warn('[nft-transfer] Sender and recipient cannot be the same for a regular NFT transfer.');
        return false;
      }
      if (collection.transferable === false) { // Explicitly check for false, as undefined defaults to true
        logger.warn(`[nft-transfer] NFT Collection ${data.collectionSymbol} does not allow transfer of its NFTs.`);
        return false;
      }
      const recipientAccount = await cache.findOnePromise('accounts', { name: data.to });
      if (!recipientAccount) {
        logger.warn(`[nft-transfer] Recipient account ${data.to} not found.`);
        return false;
      }
    }
    return true;
  } catch (error) {
    logger.error(`[nft-transfer/burn] Error validating NFT transfer/burn: ${error}`);
    return false;
  }
}

export async function process(data: NftTransferData, sender: string): Promise<boolean> {
  const isBurning = data.to === BURN_ACCOUNT_NAME;
  const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
  let originalNftOwner: string | null = null; // For potential rollback if transfer fails

  try {
    // Fetch NFT to confirm current owner again before proceeding (safeguard against race conditions)
    const nftToProcess = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance | null;
    if (!nftToProcess || nftToProcess.owner !== sender) {
        logger.error(`[${isBurning?'nft-burn':'nft-transfer'}] CRITICAL: NFT ${fullInstanceId} not found or sender ${sender} is not owner during processing. Validation might be stale.`);
        return false;
    }
    originalNftOwner = nftToProcess.owner; // Should be sender

    if (isBurning) {
      // --- BURN LOGIC ---
      // 1. Delete the NFT instance
      // Assuming cache.deleteOnePromise exists and returns boolean for success
      const deleteSuccess = await cache.deleteOnePromise('nfts', { _id: fullInstanceId });
      if (!deleteSuccess) {
        logger.error(`[nft-burn] Failed to delete NFT ${fullInstanceId} from cache.`);
        return false; // Cannot proceed with burn if NFT deletion fails
      }

      // 2. Decrement currentSupply in the collection
      const collectionUpdateSuccess = await cache.updateOnePromise(
        'nftCollections',
        { _id: data.collectionSymbol },
        { $inc: { currentSupply: -1 } }
      );
      if (!collectionUpdateSuccess) {
        logger.error(`[nft-burn] CRITICAL: Failed to update currentSupply for collection ${data.collectionSymbol} after burning ${fullInstanceId}. NFT deleted but collection supply incorrect.`);
        // At this point, NFT is deleted but collection count is wrong. Needs reconciliation.
        // Re-creating the NFT is complex; logging is key here.
      }

      logger.info(`[nft-burn] NFT ${fullInstanceId} successfully burnt by ${sender}. Memo: ${data.memo || 'N/A'}`);
      const burnEvent = {
        type: 'nftBurn',
        timestamp: new Date().toISOString(),
        actor: sender,
        data: { collectionSymbol: data.collectionSymbol, instanceId: data.instanceId, from: sender, memo: data.memo || null }
      };
      await new Promise<void>((resolve) => {
        cache.insertOne('events', burnEvent, (err, result) => {
            if (err || !result) logger.error(`[nft-burn] CRITICAL: Failed to log nftBurn event for ${fullInstanceId}: ${err || 'no result'}.`);
            resolve();
        });
      });
    } else {
      // --- REGULAR TRANSFER LOGIC ---
      // 1. Update NFT owner
      const updateOwnerSuccess = await cache.updateOnePromise(
        'nfts',
        { _id: fullInstanceId, owner: sender }, // Ensure sender is still owner
        { $set: { owner: data.to, lastTransferredAt: new Date().toISOString() } }
      );

      if (!updateOwnerSuccess) {
        logger.error(`[nft-transfer] Failed to update owner for NFT ${fullInstanceId} to ${data.to}.`);
        return false;
      }

      // No adjustNodeAppr for NFTs in this version
      logger.info(`[nft-transfer] NFT ${fullInstanceId} successfully transferred from ${sender} to ${data.to}. Memo: ${data.memo || 'N/A'}`);
      const transferEvent = {
        type: 'nftTransfer',
        timestamp: new Date().toISOString(),
        actor: sender,
        data: { collectionSymbol: data.collectionSymbol, instanceId: data.instanceId, from: sender, to: data.to, memo: data.memo || null }
      };
      await new Promise<void>((resolve) => {
        cache.insertOne('events', transferEvent, (err, result) => {
            if (err || !result) logger.error(`[nft-transfer] CRITICAL: Failed to log nftTransfer event for ${fullInstanceId}: ${err || 'no result'}.`);
            resolve();
        });
      });
    }
    return true;
  } catch (error) {
    logger.error(`[${isBurning?'nft-burn':'nft-transfer'}] Error processing NFT operation for ${fullInstanceId}: ${error}`);
    // Attempt rollback for failed transfer if original owner was captured and it's not a burn
    if (!isBurning && originalNftOwner) {
        try {
            await cache.updateOnePromise('nfts', {_id: fullInstanceId, owner: data.to }, {$set: {owner: originalNftOwner}});
            logger.info(`[nft-transfer] Attempted to roll back NFT ${fullInstanceId} ownership to ${originalNftOwner} due to error.`);
        } catch (rollbackError) {
            logger.error(`[nft-transfer] CRITICAL: Failed to roll back NFT ${fullInstanceId} ownership after error: ${rollbackError}`);
        }
    }
    return false;
  }
} 