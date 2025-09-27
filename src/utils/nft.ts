import { NftInstance } from '../transactions/nft/nft-transfer.js';

export const MAX_COLLECTION_SUPPLY = 1000000;

/**
 * Get the cover URL for an NFT
 * @param nft The NFT instance
 * @param collectionBaseCoverUrl The base cover URL from the collection
 * @returns The cover URL for the NFT
 */
export function getNftCoverUrl(nft: NftInstance, collectionBaseCoverUrl?: string): string | undefined {
    // If the NFT has its own cover URL, use it
    if (nft.coverUrl) {
        return nft.coverUrl;
    }

    // If the collection has a base cover URL and the NFT has an index, construct the URL
    if (collectionBaseCoverUrl && nft.index) {
        // Replace {index} placeholder with the actual index
        return collectionBaseCoverUrl.replace('{index}', nft.index.toString());
    }

    // No cover URL available
    return undefined;
}

/**
 * Get the display name for an NFT
 * @param nft The NFT instance
 * @param collectionName The name of the collection
 * @returns The display name (e.g., "My Collection #1")
 */
export function getNftDisplayName(nft: NftInstance, collectionName: string): string {
    return `${collectionName} #${nft.index || nft.tokenId}`;
}
