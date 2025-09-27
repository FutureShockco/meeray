import cache from '../../cache.js';
import logger from '../../logger.js';
import { logEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { NFTTokenData, NFTUpdateMetadataData } from './nft-interfaces.js';

export async function validateTx(data: NFTUpdateMetadataData, sender: string): Promise<boolean> {
    try {
        if (!data.collectionSymbol || !data.instanceId) {
            logger.warn('[nft-update] Invalid data: Missing required fields (collectionSymbol, instanceId).');
            return false;
        }
        if (!validate.string(data.collectionSymbol, 10, 3)) {
            logger.warn(`[nft-update] Invalid collection symbol format: ${data.collectionSymbol}.`);
            return false;
        }
        if (!validate.string(data.instanceId, 128, 1)) {
            logger.warn('[nft-update] Invalid instanceId length (1-128 chars).');
            return false;
        }
        if (data.uri !== undefined && (!validate.string(data.uri, 2048, 10) || !(data.uri.startsWith('http') || data.uri.startsWith('ipfs:')))) {
            logger.warn('[nft-update] Invalid uri: incorrect format, or length (10-2048 chars), must start with http or ipfs:');
            return false;
        }
        if (data.coverUrl !== undefined && (!validate.string(data.coverUrl, 2048, 10) || !data.coverUrl.startsWith('http'))) {
            logger.warn('[nft-update] Invalid coverUrl: incorrect format, or length (10-2048 chars), must start with http.');
            return false;
        }
        if (data.metadata !== undefined && typeof data.metadata !== 'object' || (!validate.json(data.metadata, 2048))) {
            logger.warn('[nft-update] Metadata, if provided, must be a valid JSON object.');
            return false;
        }
        const fullInstanceId = `${data.collectionSymbol}_${data.instanceId}`;
        const nft = (await cache.findOnePromise('nfts', { _id: fullInstanceId })) as NFTTokenData | null;
        if (!nft) {
            logger.warn(`[nft-update] NFT ${fullInstanceId} not found.`);
            return false;
        }
        if (nft.owner !== sender) {
            logger.warn(`[nft-update] Sender ${sender} is not the owner of NFT ${fullInstanceId}. Current owner: ${nft.owner}.`);
            return false;
        }
        const collection = await cache.findOnePromise('nftCollections', { _id: data.collectionSymbol });
        if (!collection) {
            logger.warn(`[nft-update] Collection ${data.collectionSymbol} not found.`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`[nft-update] Error validating NFT update for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: NFTUpdateMetadataData, sender: string, _id: string): Promise<boolean> {
    try {
        const fullInstanceId = `${data.collectionSymbol}_${data.instanceId}`;
        const nft = (await cache.findOnePromise('nfts', { _id: fullInstanceId })) as NFTTokenData | null;
        if (!nft || nft.owner !== sender) {
            logger.error(`[nft-update] CRITICAL: NFT ${fullInstanceId} not found or sender ${sender} is not owner during processing.`);
            return false;
        }
        const updateFields: any = {
            lastUpdatedAt: new Date().toISOString(),
        };
        if (data.metadata !== undefined) {
            updateFields.metadata = data.metadata;
        }
        if (data.uri !== undefined) {
            updateFields.uri = data.uri;
        }
        if (data.coverUrl !== undefined) {
            updateFields.coverUrl = data.coverUrl;
        }
        const updateSuccess = await cache.updateOnePromise('nfts', { _id: fullInstanceId, owner: sender }, { $set: updateFields });
        if (!updateSuccess) {
            logger.error(`[nft-update] Failed to update NFT ${fullInstanceId}.`);
            return false;
        }
        logger.debug(`[nft-update] NFT ${fullInstanceId} successfully updated by ${sender}.`);
        await logEvent('nft', 'updated', sender, {
            collectionSymbol: data.collectionSymbol,
            instanceId: data.instanceId,
            fullInstanceId,
            owner: sender,
            updatedFields: updateFields,
        });
        return true;
    } catch (error) {
        logger.error(`[nft-update] Error processing NFT update for ${data.collectionSymbol}_${data.instanceId} by ${sender}: ${error}`);
        return false;
    }
}
