import { BigIntToString } from '../../utils/bigint.js';

/**
 * NFT interfaces with BigInt values for application logic
 */

export interface NFTCollectionCreateData {
    symbol: string;            // Collection symbol (e.g., "PUNKS")
    name: string;             // Collection name (e.g., "CryptoPunks")
    description?: string;     // Collection description
    maxSupply?: bigint;      // Maximum number of NFTs that can be minted
    royaltyBps?: number;     // Royalty percentage in basis points (e.g., 250 = 2.5%)
    creator: string;         // Creator's address
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
}

export interface NFTMintData {
    collectionId: string;    // Collection ID to mint the NFT in
    tokenId: string;        // Unique token ID within the collection
    recipient: string;      // Address to receive the NFT
    metadata?: {
        name?: string;
        description?: string;
        imageUrl?: string;
        attributes?: Array<{
            trait_type: string;
            value: string | number;
        }>;
        [key: string]: any;
    };
}

export interface NFTTransferData {
    collectionId: string;   // Collection ID
    tokenId: string;       // Token ID within the collection
    from: string;          // Current owner's address
    to: string;           // Recipient's address
    memo?: string;        // Optional memo/note for the transfer
}

export interface NFTCollection {
    _id: string;           // Collection ID: hash(symbol, creator)
    symbol: string;        // Collection symbol
    name: string;         // Collection name
    description?: string; // Collection description
    maxSupply?: bigint;  // Maximum number of NFTs that can be minted
    totalSupply: bigint; // Current number of NFTs minted
    royaltyBps: number;  // Royalty percentage in basis points
    creator: string;     // Creator's address
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
    status: 'active' | 'paused' | 'ended';
    createdAt: string;
    lastUpdatedAt?: string;
}

export interface NFTToken {
    _id: string;          // Token ID: collectionId-tokenId
    collectionId: string; // Collection this token belongs to
    tokenId: string;     // Unique token ID within the collection
    owner: string;       // Current owner's address
    metadata?: {
        name?: string;
        description?: string;
        imageUrl?: string;
        attributes?: Array<{
            trait_type: string;
            value: string | number;
        }>;
        [key: string]: any;
    };
    createdAt: string;
    lastTransferAt?: string;
}

export interface NFTTransfer {
    _id: string;         // Transfer ID: hash(collectionId, tokenId, from, to, timestamp)
    collectionId: string;
    tokenId: string;
    from: string;
    to: string;
    memo?: string;
    timestamp: string;   // ISO date string
}

/**
 * Database types (automatically converted from base types)
 */
export type NFTCollectionCreateDataDB = BigIntToString<NFTCollectionCreateData>;
export type NFTCollectionDB = BigIntToString<NFTCollection>;

export interface NftCreateCollectionData {
  symbol: string;        // e.g., "MYART", max 10 chars, uppercase, unique
  name: string;           // e.g., "My Art Collection", max 50 chars
  creator: string;        // Account name of the collection creator
  maxSupply?: number;     // Max NFTs in collection (0 or undefined for unlimited). Must be >= current supply if set.
  mintable: boolean;      // Can new NFTs be minted after initial setup?
  burnable?: boolean;     // Can NFTs from this collection be burned? (default true)
  transferable?: boolean; // Can NFTs be transferred? (default true)
  creatorFee?: number;    // Royalty percentage (e.g., 5 for 5%). Min 0, Max 25 (for 25%). Optional, defaults to 0.
  schema?: string;        // Optional JSON schema string for NFT properties
  description?: string;   // Max 1000 chars
  logoUrl?: string;       // Max 2048 chars, must be valid URL
  websiteUrl?: string;    // Max 2048 chars, must be valid URL
  baseCoverUrl?: string;  // Base cover URL for NFTs in this collection (max 2048 chars, must be valid URL)
}

export interface NftMintData {
  collectionSymbol: string; // Symbol of the collection to mint into
  owner: string;            // Account name of the new NFT owner
  properties?: Record<string, any>; // NFT instance-specific properties
  // immutableProperties?: boolean; // If true, instance properties cannot be changed. Default false.
  uri?: string;             // URI pointing to off-chain metadata or asset (max 2048 chars)
  coverUrl?: string;        // Individual cover URL for this NFT (max 2048 chars, must be valid URL)
}

export interface NftTransferData {
  collectionSymbol: string;
  instanceId: string;       // ID of the NFT instance to transfer
  to: string;               // Account name of the new owner
  memo?: string;             // Optional memo (max 256 chars)
}

// NftBurnData is not needed if burning is transfer to null account via NftTransferData

export interface NftUpdateMetadataData {
  collectionSymbol: string;
  instanceId: string;
  // owner can only be changed via transfer
  properties?: Record<string, any>; // New set of mutable properties, or specific properties to update
  uri?: string;                    // New URI (max 2048 chars)
  coverUrl?: string;               // Individual cover URL for this NFT (max 2048 chars, must be valid URL)
}

export interface NftUpdateCollectionData {
  symbol: string;                  // Collection symbol to update
  name?: string;                   // New collection name (max 50 chars)
  description?: string;            // New description (max 1000 chars)
  logoUrl?: string;                // New logo URL (max 2048 chars, must be valid URL)
  websiteUrl?: string;             // New website URL (max 2048 chars, must be valid URL)
  baseCoverUrl?: string;           // New base cover URL (max 2048 chars, must be valid URL)
  mintable?: boolean;              // Update mintable status
  burnable?: boolean;              // Update burnable status
  transferable?: boolean;          // Update transferable status
  creatorFee?: number;             // Update creator fee (0-25)
} 