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
}

export interface NftMintData {
  collectionSymbol: string; // Symbol of the collection to mint into
  instanceId?: string;      // Optional: User-defined ID for the NFT (unique within collection). If not provided, will be auto-generated (e.g., UUID).
  owner: string;            // Account name of the new NFT owner
  properties?: Record<string, any>; // NFT instance-specific properties
  // immutableProperties?: boolean; // If true, instance properties cannot be changed. Default false.
  uri?: string;             // URI pointing to off-chain metadata or asset (max 2048 chars)
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
} 