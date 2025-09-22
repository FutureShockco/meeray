import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NFTCollectionCreateData } from './nft-interfaces.js';
import config from '../../config.js';
import { adjustBalance } from '../../utils/account.js';
import { logEvent } from '../../utils/event-logger.js';

export async function validateTx(data: NFTCollectionCreateData, sender: string): Promise<boolean> {
  try {
    if (!data.symbol || !data.name || !data.creator) {
      logger.warn('[nft-create-collection] Invalid data: Missing required fields (symbol, name, creator).');
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

    // Validate creator matches sender
    if (data.creator !== sender) {
      logger.warn('[nft-create-collection] Creator field must match transaction sender.');
      return false;
    }

    if (data.maxSupply !== undefined) {
      if (typeof data.maxSupply === 'string') {
        // Validate string is a valid number
        const maxSupplyNum = BigInt(data.maxSupply);
        if (maxSupplyNum < 0) {
          logger.warn('[nft-create-collection] Invalid maxSupply. Must be non-negative.');
          return false;
        }
      } else if (typeof data.maxSupply === 'bigint') {
        if (data.maxSupply < 0) {
          logger.warn('[nft-create-collection] Invalid maxSupply. Must be non-negative.');
          return false;
        }
      } else {
        logger.warn('[nft-create-collection] Invalid maxSupply type. Must be string or bigint.');
        return false;
      }
    }

    // Validate royalty (basis points only)
    if (data.royaltyBps !== undefined && !validate.integer(data.royaltyBps, true, false, 2500, 0)) {
      logger.warn(`[nft-create-collection] Invalid royaltyBps: ${data.royaltyBps}. Must be 0-2500 basis points (0-25%).`);
      return false;
    }

    // Validate boolean fields
    if (data.mintable !== undefined && !validate.boolean(data.mintable)) {
      logger.warn('[nft-create-collection] Invalid mintable flag.');
      return false;
    }
    if (data.burnable !== undefined && !validate.boolean(data.burnable)) {
      logger.warn('[nft-create-collection] Invalid burnable flag.');
      return false;
    }
    if (data.transferable !== undefined && typeof data.transferable !== 'boolean') {
      logger.warn('[nft-create-collection] Invalid transferable flag.');
      return false;
    }

    // Validate string fields
    if (data.schema !== undefined && typeof data.schema !== 'string') {
      logger.warn('[nft-create-collection] Schema must be a string.');
      return false;
    }
    if (data.description !== undefined && !validate.string(data.description, 1000, 0)) {
      logger.warn('[nft-create-collection] Invalid description length.');
      return false;
    }

    // Validate URLs
    const urlFields = ['logoUrl', 'websiteUrl', 'baseCoverUrl'];
    for (const field of urlFields) {
      const url = data[field as keyof typeof data] as string;
      if (url !== undefined && (!validate.string(url, 2048, 10) || !url.startsWith('http'))) {
        logger.warn(`[nft-create-collection] Invalid ${field}.`);
        return false;
      }
    }
    if (data.metadata?.imageUrl !== undefined && (!validate.string(data.metadata.imageUrl, 2048, 10) || !data.metadata.imageUrl.startsWith('http'))) {
      logger.warn('[nft-create-collection] Invalid metadata imageUrl.');
      return false;
    }
    if (data.metadata?.externalUrl !== undefined && (!validate.string(data.metadata.externalUrl, 2048, 10) || !data.metadata.externalUrl.startsWith('http'))) {
      logger.warn('[nft-create-collection] Invalid metadata externalUrl.');
      return false;
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
    
    if (BigInt(creatorAccount.balances[config.nativeTokenSymbol]) < BigInt(config.nftCollectionCreationFee)) {
      logger.warn(`[nft-create-collection] Sender account ${sender} does not have enough balance to create an NFT collection.`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[nft-create-collection] Error validating data for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
}

export async function processTx(data: NFTCollectionCreateData, sender: string, id: string): Promise<boolean> {
  try {
    const existingCollection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
    if (existingCollection) {
      logger.error(`[nft-create-collection] Collection with symbol ${data.symbol} already exists during processing.`);
      return false;
    }

    // Convert maxSupply to number for storage, handling string | bigint
    let maxSupplyForStorage: number;
    if (data.maxSupply === undefined) {
      maxSupplyForStorage = Number.MAX_SAFE_INTEGER;
    } else if (typeof data.maxSupply === 'string') {
      maxSupplyForStorage = Number(data.maxSupply);
    } else if (typeof data.maxSupply === 'bigint') {
      maxSupplyForStorage = Number(data.maxSupply);
    } else {
      maxSupplyForStorage = Number.MAX_SAFE_INTEGER;
    }

    const collectionToStore = {
      _id: data.symbol,
      symbol: data.symbol,
      name: data.name,
      description: data.description || '',
      creator: data.creator,
      currentSupply: 0,
      nextIndex: 1,  // Start indexing from 1
      maxSupply: maxSupplyForStorage,
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      transferable: data.transferable === undefined ? true : data.transferable,
      royaltyBps: data.royaltyBps || 0, // Store only royaltyBps (basis points)
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      baseCoverUrl: data.baseCoverUrl || '',
      schema: data.schema || '',
      metadata: data.metadata || {},
      createdAt: new Date().toISOString()
    };

    const insertSuccess = await new Promise<boolean>((resolve) => {
      cache.insertOne('nftCollections', collectionToStore, (err, result) => {
        if (err || !result) {
          logger.error(`[nft-create-collection] Failed to insert collection ${data.symbol}: ${err || 'no result'}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!insertSuccess) {
      return false;
    }

    const deductSuccess = await adjustBalance(sender, config.nativeTokenSymbol, BigInt(-config.nftCollectionCreationFee));
    if (!deductSuccess) {
      logger.error(`[nft-create-collection] Failed to deduct ${config.nftCollectionCreationFee} of ${config.nativeTokenSymbol} from ${sender}.`);
      return false;
    }

    logger.debug(`[nft-create-collection] Collection ${data.symbol} created successfully by ${sender}.`);

    // Log event
    await logEvent('nft', 'collection_created', sender, {
      symbol: data.symbol,
      name: data.name,
      creator: data.creator,
      description: data.description || '',
      maxSupply: maxSupplyForStorage,
      mintable: data.mintable === undefined ? true : data.mintable,
      burnable: data.burnable === undefined ? true : data.burnable,
      transferable: data.transferable === undefined ? true : data.transferable,
      royaltyBps: data.royaltyBps || 0, // Store only royaltyBps (basis points)
      logoUrl: data.logoUrl || '',
      websiteUrl: data.websiteUrl || '',
      baseCoverUrl: data.baseCoverUrl || '',
      schema: data.schema || '',
      metadata: data.metadata || {},
      creationFee: config.nftCollectionCreationFee,
      nativeTokenSymbol: config.nativeTokenSymbol
    });

    return true;
  } catch (error) {
    logger.error(`[nft-create-collection] Error processing collection creation for ${data.symbol} by ${sender}: ${error}`);
    return false;
  }
} 