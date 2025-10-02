import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { MAX_COLLECTION_SUPPLY } from '../../utils/nft.js';
import validate from '../../validation/index.js';
import { NFTCollectionCreateData } from './nft-interfaces.js';


export async function validateTx(data: NFTCollectionCreateData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.symbol || !data.name) {
            logger.warn('[nft-create-collection] Invalid data: Missing required fields (symbol, name, creator).');
            return { valid: false, error: 'missing required fields' };
        }

        if (!validate.string(data.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[nft-create-collection] Invalid symbol: ${data.symbol}. Must be 3-10 uppercase letters.`);
            return { valid: false, error: 'invalid symbol' };
        }

        if (!validate.string(data.name, 50, 1)) {
            logger.warn('[nft-create-collection] Invalid name length (must be 1-50 characters).');
            return { valid: false, error: 'invalid name length' };
        }

        if (!validate.integer(data.maxSupply, false, false, MAX_COLLECTION_SUPPLY, 1)) {
            logger.warn('[nft-create-collection] Invalid maxSupply. Must be a non-negative integer or undefined for unlimited.');
            return { valid: false, error: 'invalid maxSupply' };
        }

        if (data.royaltyBps !== undefined && !validate.integer(data.royaltyBps, true, false, 2500, 0)) {
            logger.warn(`[nft-create-collection] Invalid royaltyBps: ${data.royaltyBps}. Must be 0-2500 basis points (0-25%).`);
            return { valid: false, error: 'invalid royaltyBps' };
        }

        if (data.mintable !== undefined && !validate.boolean(data.mintable)) {
            logger.warn('[nft-create-collection] Invalid mintable flag.');
            return { valid: false, error: 'invalid mintable flag' };
        }
        if (data.burnable !== undefined && !validate.boolean(data.burnable)) {
            logger.warn('[nft-create-collection] Invalid burnable flag.');
            return { valid: false, error: 'invalid burnable flag' };
        }
        if (data.transferable !== undefined && typeof data.transferable !== 'boolean') {
            logger.warn('[nft-create-collection] Invalid transferable flag.');
            return { valid: false, error: 'invalid transferable flag' };
        }

        if (data.description !== undefined && !validate.string(data.description, 512, 0)) {
            logger.warn('[nft-create-collection] Invalid description length.');
            return { valid: false, error: 'invalid description length' };
        }

        if (data.websiteUrl !== undefined && !validate.validateUrl(data.websiteUrl, 512)) {
            logger.warn('[nft-create-collection] Invalid website URL.');
            return { valid: false, error: 'invalid website URL' };
        }

        const urlFields = ['logoUrl', 'baseCoverUrl'];
        for (const field of urlFields) {
            const url = data[field as keyof typeof data] as string;
            if (url !== undefined && (!validate.validateLogoUrl(url, 512))) {
                logger.warn(`[nft-create-collection] Invalid ${field}.`);
                return { valid: false, error: `invalid ${field}` };
            }
        }

        const existingCollection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
        if (existingCollection) {
            logger.warn(`[nft-create-collection] NFT Collection with symbol ${data.symbol} already exists.`);
            return { valid: false, error: 'collection already exists' };
        }

        const senderAccount = await cache.findOnePromise('accounts', { name: sender });
        if (!senderAccount) {
            logger.warn(`[nft-create-collection] Sender account ${sender} not found.`);
            return { valid: false, error: 'sender account not found' };
        }

        if (toBigInt(senderAccount.balances[config.nativeTokenSymbol]) < toBigInt(config.nftCollectionCreationFee)) {
            logger.warn(`[nft-create-collection] Sender account ${sender} does not have enough balance to create an NFT collection.`);
            return { valid: false, error: 'insufficient funds' };
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[nft-create-collection] Error validating data for ${data.symbol} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: NFTCollectionCreateData, sender: string, _id: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const existingCollection = await cache.findOnePromise('nftCollections', { _id: data.symbol });
        if (existingCollection) {
            logger.error(`[nft-create-collection] Collection with symbol ${data.symbol} already exists during processing.`);
            return { valid: false, error: 'collection already exists' };
        }

        const collectionToStore = {
            _id: data.symbol,
            symbol: data.symbol,
            name: data.name,
            description: data.description || '',
            creator: sender,
            currentSupply: 0,
            nextIndex: 1,
            maxSupply: data.maxSupply,
            mintable: data.mintable === undefined ? true : data.mintable,
            burnable: data.burnable === undefined ? true : data.burnable,
            transferable: data.transferable === undefined ? true : data.transferable,
            royaltyBps: data.royaltyBps || 0,
            logoUrl: data.logoUrl || '',
            websiteUrl: data.websiteUrl || '',
            baseCoverUrl: data.baseCoverUrl || '',
            createdAt: new Date().toISOString(),
        };

        const insertSuccess = await new Promise<boolean>(resolve => {
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
            return { valid: false, error: 'failed to insert collection' };
        }

        const deductSuccess = await adjustUserBalance(sender, config.nativeTokenSymbol, toBigInt(-config.nftCollectionCreationFee));
        if (!deductSuccess) {
            logger.error(`[nft-create-collection] Failed to deduct ${config.nftCollectionCreationFee} of ${config.nativeTokenSymbol} from ${sender}.`);
            return { valid: false, error: 'failed to deduct creation fee' };
        }

        logger.debug(`[nft-create-collection] Collection ${data.symbol} created successfully by ${sender}.`);

        await logEvent('nft', 'collection_created', sender, {
            symbol: data.symbol,
            name: data.name,
            creator: sender,
            description: data.description || '',
            maxSupply: data.maxSupply,
            mintable: data.mintable === undefined ? true : data.mintable,
            burnable: data.burnable === undefined ? true : data.burnable,
            transferable: data.transferable === undefined ? true : data.transferable,
            royaltyBps: data.royaltyBps || 0, // Store only royaltyBps (basis points)
            logoUrl: data.logoUrl || '',
            websiteUrl: data.websiteUrl || '',
            baseCoverUrl: data.baseCoverUrl || '',
            creationFee: config.nftCollectionCreationFee,
            nativeTokenSymbol: config.nativeTokenSymbol,
        });

        return { valid: true };
    } catch (error) {
        logger.error(`[nft-create-collection] Error processing collection creation for ${data.symbol} by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
