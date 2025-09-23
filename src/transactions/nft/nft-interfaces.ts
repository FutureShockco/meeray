// NFT interfaces with string | bigint for all numeric fields

export interface NFTCollectionCreateData {
    symbol: string; // Collection symbol (e.g., "PUNKS")
    name: string; // Collection name (e.g., "CryptoPunks")
    description?: string; // Collection description
    maxSupply?: string | bigint; // Maximum number of NFTs that can be minted
    royaltyBps?: number; // Royalty in basis points (e.g., 250 = 2.5%, max 2500 = 25%)
    creator: string; // Creator's address
    mintable?: boolean; // Can new NFTs be minted after initial setup?
    burnable?: boolean; // Can NFTs from this collection be burned? (default true)
    transferable?: boolean; // Can NFTs be transferred? (default true)
    schema?: string; // Optional JSON schema string for NFT properties
    logoUrl?: string; // Logo URL for the collection (max 2048 chars, must be valid URL)
    websiteUrl?: string; // Website URL for the collection (max 2048 chars, must be valid URL)
    baseCoverUrl?: string; // Base cover URL for NFTs in this collection (max 2048 chars, must be valid URL)
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
}

export interface NFTMintData {
    collectionId?: string; // Collection ID to mint the NFT in (new format)
    collectionSymbol?: string; // Collection symbol (legacy format)
    tokenId?: string; // Unique token ID within the collection (new format)
    instanceId?: string; // Legacy instance ID
    recipient?: string; // Address to receive the NFT (new format)
    owner?: string; // Account name of the new NFT owner (legacy format)
    properties?: Record<string, any>; // NFT instance-specific properties (legacy)
    uri?: string; // URI pointing to off-chain metadata or asset (max 2048 chars)
    coverUrl?: string; // Individual cover URL for this NFT (max 2048 chars, must be valid URL)
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
    collectionId?: string; // Collection ID (new format)
    collectionSymbol?: string; // Collection symbol (legacy format)
    tokenId?: string; // Token ID within the collection (new format)
    instanceId?: string; // Instance ID (legacy format)
    from?: string; // Current owner's address (new format)
    to: string; // Recipient's address
    memo?: string; // Optional memo/note for the transfer
}

export interface NFTCollectionData {
    _id: string; // Collection ID: hash(symbol, creator)
    symbol: string; // Collection symbol
    name: string; // Collection name
    description?: string; // Collection description
    maxSupply?: string | bigint; // Maximum number of NFTs that can be minted
    totalSupply: string | bigint; // Current number of NFTs minted
    royaltyBps: number; // Royalty percentage in basis points
    creator: string; // Creator's address
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
    status: 'active' | 'paused' | 'ended';
    createdAt: string;
    lastUpdatedAt?: string;
}

export interface NFTTokenData {
    _id: string; // Token ID: collectionId-tokenId
    collectionId: string; // Collection this token belongs to
    tokenId: string; // Unique token ID within the collection
    owner: string; // Current owner's address
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

export interface NFTTransferHistoryData {
    _id: string; // Transfer ID: hash(collectionId, tokenId, from, to, timestamp)
    collectionId: string;
    tokenId: string;
    from: string;
    to: string;
    memo?: string;
    timestamp: string; // ISO date string
}

export interface NFTUpdateMetadataData {
    collectionSymbol?: string; // Legacy format
    collectionId?: string; // New format
    instanceId?: string; // Legacy format
    tokenId?: string; // New format
    properties?: Record<string, any>; // New set of mutable properties, or specific properties to update
    uri?: string; // New URI (max 2048 chars)
    coverUrl?: string; // Individual cover URL for this NFT (max 2048 chars, must be valid URL)
    metadata?: {
        // New format metadata
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

export interface NFTUpdateCollectionData {
    symbol: string; // Collection symbol to update
    name?: string; // New collection name (max 50 chars)
    description?: string; // New description (max 1000 chars)
    logoUrl?: string; // New logo URL (max 2048 chars, must be valid URL)
    websiteUrl?: string; // New website URL (max 2048 chars, must be valid URL)
    baseCoverUrl?: string; // New base cover URL (max 2048 chars, must be valid URL)
    mintable?: boolean; // Update mintable status
    burnable?: boolean; // Update burnable status
    transferable?: boolean; // Update transferable status
    royaltyBps?: number; // Update royalty in basis points (0-2500 = 0-25%)
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
}
