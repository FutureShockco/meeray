

export interface NFTCollectionCreateData {
    symbol: string; 
    name: string; 
    description?: string; 
    maxSupply?: string | bigint; 
    royaltyBps?: number; 
    creator: string; 
    mintable?: boolean; 
    burnable?: boolean; 
    transferable?: boolean; 
    schema?: string; 
    logoUrl?: string; 
    websiteUrl?: string; 
    baseCoverUrl?: string; 
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
}

export interface NFTMintData {
    collectionId?: string; 
    collectionSymbol?: string; 
    tokenId?: string; 
    instanceId?: string; 
    recipient?: string; 
    owner?: string; 
    properties?: Record<string, any>; 
    uri?: string; 
    coverUrl?: string; 
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
    collectionId?: string; 
    collectionSymbol?: string; 
    tokenId?: string; 
    instanceId?: string; 
    from?: string; 
    to: string; 
    memo?: string; 
}

export interface NFTCollectionData {
    _id: string; 
    symbol: string; 
    name: string; 
    description?: string; 
    maxSupply?: string | bigint; 
    totalSupply: string | bigint; 
    royaltyBps: number; 
    creator: string; 
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
    status: 'ACTIVE' | 'PAUSED' | 'ENDED';
    createdAt: string;
    lastUpdatedAt?: string;
}

export interface NFTTokenData {
    _id: string; 
    collectionId: string; 
    tokenId: string; 
    owner: string; 
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
    _id: string; 
    collectionId: string;
    tokenId: string;
    from: string;
    to: string;
    memo?: string;
    timestamp: string; 
}

export interface NFTUpdateMetadataData {
    collectionSymbol?: string; 
    collectionId?: string; 
    instanceId?: string; 
    tokenId?: string; 
    properties?: Record<string, any>; 
    uri?: string; 
    coverUrl?: string; 
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

export interface NFTUpdateCollectionData {
    symbol: string; 
    name?: string; 
    description?: string; 
    logoUrl?: string; 
    websiteUrl?: string; 
    baseCoverUrl?: string; 
    mintable?: boolean; 
    burnable?: boolean; 
    transferable?: boolean; 
    royaltyBps?: number; 
    metadata?: {
        imageUrl?: string;
        externalUrl?: string;
        [key: string]: any;
    };
}
