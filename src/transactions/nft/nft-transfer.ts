import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js'; // For BURN_ACCOUNT_NAME eventually
import { NFTTransferData, NFTCollectionCreateData } from './nft-interfaces.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const BURN_ACCOUNT_NAME = 'null';

export interface CachedNftCollectionForTransfer extends NFTCollectionCreateData {
    _id: string;
}

export interface NftInstance {
    _id: string;
    collectionSymbol: string;
    instanceId: string;
    owner: string;
    index?: number;        // Sequential index within the collection (1, 2, 3, etc.)
    coverUrl?: string;     // Individual cover URL for this NFT (max 2048 chars, must be valid URL)
    properties?: Record<string, any>; // Optional instance-specific properties
}

export async function validateTx(data: NFTTransferData, sender: string): Promise<boolean> {
  try {
    if (!data.collectionSymbol || !data.instanceId || !data.to) {
      logger.warn('[nft-transfer/burn] Invalid data: Missing required fields (collectionSymbol, instanceId, to).');
      return false;
    }

    // Validate formats
    if (!validate.string(data.collectionSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
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

export async function process(data: NFTTransferData, sender: string, id: string): Promise<boolean> {
  const isBurning = data.to === BURN_ACCOUNT_NAME;
  
  // Ensure required fields are present
  if (!data.collectionSymbol || !data.instanceId) {
    logger.error(`[nft-transfer] Missing required fields: collectionSymbol=${data.collectionSymbol}, instanceId=${data.instanceId}`);
    return false;
  }
  
  const fullInstanceId = `${data.collectionSymbol}-${data.instanceId}`;
  let originalNftOwner: string | null = null; // No manual rollback needed; block-level rollback will discard changes

  try {
    // Fetch NFT to confirm current owner again before proceeding (safeguard against race conditions)
    const nftToProcess = await cache.findOnePromise('nfts', { _id: fullInstanceId }) as NftInstance;
    if (nftToProcess.owner !== sender) {
        logger.error(`[${isBurning?'nft-burn':'nft-transfer'}] CRITICAL: Sender ${sender} is not owner during processing. Validation might be stale.`);
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

      logger.debug(`[nft-burn] NFT ${fullInstanceId} successfully burnt by ${sender}. Memo: ${data.memo || 'N/A'}`);
      
      // Log burn event
      await logTransactionEvent('nft_burn', sender, {
        collectionSymbol: data.collectionSymbol,
        instanceId: data.instanceId,
        fullInstanceId,
        from: sender,
        to: data.to,
        memo: data.memo
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

      logger.debug(`[nft-transfer] NFT ${fullInstanceId} successfully transferred from ${sender} to ${data.to}. Memo: ${data.memo || 'N/A'}`);
      
      // Log transfer event
      await logTransactionEvent('nft_transfer', sender, {
        collectionSymbol: data.collectionSymbol,
        instanceId: data.instanceId,
        fullInstanceId,
        from: sender,
        to: data.to,
        memo: data.memo
      });
    }
    return true;
  } catch (error) {
    logger.error(`[${isBurning?'nft-burn':'nft-transfer'}] Error processing NFT operation for ${fullInstanceId}: ${error}`);
    return false;
  }
} 