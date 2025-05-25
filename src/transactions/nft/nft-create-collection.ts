import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js'; // Shared validation module
import { NftCreateCollectionData } from './nft-interfaces.js';
import config from '../../config.js'; // For potential fees or other params
import { logTransactionEvent } from '../../utils/event-logger.js'; // Import the new event logger

export async function validateTx(data: NftCreateCollectionData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.name || typeof data.mintable !== 'boolean') {
      logger.warn('[nft-create-collection] Invalid data: Missing required fields (symbol, name, mintable).');
      return false;
    }

    // Validate symbol: e.g., 3-10 uppercase letters
    if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn(`[nft-create-collection] Invalid symbol: ${data.symbol}. Must be 3-10 uppercase letters.`);
      return false;
    }
    // Validate name: e.g., 1-50 characters
    if (!validate.string(data.name, 50, 1)) {
      logger.warn('[nft-create-collection] Invalid name length (must be 1-50 characters).');
      return false;
    }

    if (data.maxSupply !== undefined) {
      if (!validate.integer(data.maxSupply, true, false, undefined, 0)) { // Can be 0 for unlimited (effectively), must be non-negative
        logger.warn('[nft-create-collection] Invalid maxSupply. Must be a non-negative integer.');
        return false;
      }
    }
    if (data.burnable !== undefined && typeof data.burnable !== 'boolean') {
        logger.warn('[nft-create-collection] Invalid burnable flag. Must be boolean.');
        return false;
    }
    if (data.transferable !== undefined && typeof data.transferable !== 'boolean') {
        logger.warn('[nft-create-collection] Invalid transferable flag. Must be boolean.');
        return false;
    }
    if (data.schema !== undefined && typeof data.schema !== 'string') {
        logger.warn('[nft-create-collection] Schema, if provided, must be a string (e.g., JSON schema).');
        return false;
    }
    if (data.description !== undefined && !validate.string(data.description, 1000, 0)) {
        logger.warn('[nft-create-collection] Invalid description length (must be 0-1000 chars).');
        return false;
    }
    if (data.logoUrl !== undefined && (!validate.string(data.logoUrl, 2048, 10) || !data.logoUrl.startsWith('http'))) {
        logger.warn('[nft-create-collection] Invalid logoUrl: incorrect format, or length (10-2048 chars).');
        return false;
    }
    if (data.websiteUrl !== undefined && (!validate.string(data.websiteUrl, 2048, 10) || !data.websiteUrl.startsWith('http'))) {
        logger.warn('[nft-create-collection] Invalid websiteUrl: incorrect format, or length (10-2048 chars).');
        return false;
    }

    // Validate creatorFee (royalty)
    if (data.creatorFee !== undefined) {
      if (!validate.integer(data.creatorFee, true, false, 25, 0)) { // Must be integer, non-negative, max 25
        logger.warn(`[nft-create-collection] Invalid creatorFee: ${data.creatorFee}. Must be an integer between 0 and 25 (inclusive).`);
        return false;
      }
    }

    // Check for symbol uniqueness
    const existingCollection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
    if (existingCollection) {
      logger.warn(`[nft-create-collection] NFT Collection with symbol ${data.symbol} already exists.`);
      return false;
    }
    
    // Validate sender account exists (creator)
    const creatorAccount = await cache.findOnePromise('accounts', { name: sender });
    if (!creatorAccount) {
      logger.warn(`[nft-create-collection] Creator account ${sender} not found.`);
      return false;
    }
    

    return true;
  } catch (error) {
    logger.error(`[nft-create-collection] Error validating data for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function process(transaction: { data: NftCreateCollectionData, sender: string, _id: string }): Promise<boolean> {
  const { data: createCollectionPayload, sender, _id: transactionId } = transaction;
  try {
    const collectionDocument = {
      _id: createCollectionPayload.symbol, // Use symbol as the primary key for the collection
      symbol: createCollectionPayload.symbol,
      name: createCollectionPayload.name,
      creator: sender,
      createdAt: new Date().toISOString(),
      maxSupply: createCollectionPayload.maxSupply === undefined || createCollectionPayload.maxSupply === 0 ? Number.MAX_SAFE_INTEGER : createCollectionPayload.maxSupply, // Store a large number for effectively unlimited
      currentSupply: 0,
      mintable: createCollectionPayload.mintable,
      burnable: createCollectionPayload.burnable === undefined ? true : createCollectionPayload.burnable,           // Default true
      transferable: createCollectionPayload.transferable === undefined ? true : createCollectionPayload.transferable, // Default true
      creatorFee: createCollectionPayload.creatorFee === undefined ? 0 : createCollectionPayload.creatorFee, // Default to 0 if not provided
      schema: createCollectionPayload.schema || null,
      description: createCollectionPayload.description || '',
      logoUrl: createCollectionPayload.logoUrl || '',
      websiteUrl: createCollectionPayload.websiteUrl || '',
    };


    const createSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftCollections', collectionDocument, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-create-collection] Failed to insert collection ${createCollectionPayload.symbol} into cache: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!createSuccess) {
      return false;
    }
    logger.debug(`[nft-create-collection] NFT Collection ${createCollectionPayload.symbol} created by ${sender}.`);

    // Log event using the new centralized logger
    // The existing logic already logs the entire collectionDocument, so we pass it as eventData.
    await logTransactionEvent('nftCreateCollection', sender, { ...collectionDocument }, transactionId);

    return true;
  } catch (error) {
    logger.error(`[nft-create-collection] Error processing creation for ${createCollectionPayload.symbol} by ${sender}: ${error}`);
    return false;
  }
} 