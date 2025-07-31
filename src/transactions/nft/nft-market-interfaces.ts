export interface NFTListingCreateData {
    collectionId: string;   // Collection ID
    tokenId: string;       // Token ID within the collection
    price: string | bigint;         // Listing price in payment token
    paymentToken: {        // Token accepted as payment
        symbol: string;
        issuer: string;
    };
    expiration?: string;   // ISO date string for listing expiration
}

export interface NFTListingCancelData {
    listingId: string;     // Listing ID to cancel
}

export interface NFTListingPurchaseData {
    listingId: string;     // Listing ID to purchase
    buyer: string;         // Buyer's address
}


export interface NFTListingData {
    _id: string;           // Listing ID: hash(collectionId, tokenId, seller, timestamp)
    collectionId: string;  // Collection ID
    tokenId: string;      // Token ID within the collection
    seller: string;       // Seller's address
    price: string | bigint;        // Listing price in payment token
    paymentToken: {       // Token accepted as payment
        symbol: string;
        issuer?: string;    // Made issuer optional
    };
    status: 'active' | 'sold' | 'cancelled';
    expiration?: string;  // ISO date string for listing expiration
    createdAt: string;
    lastUpdatedAt?: string;
}


export interface NFTSaleData {
    _id: string;          // Sale ID: hash(listingId, buyer, timestamp)
    listingId: string;    // Original listing ID
    collectionId: string; // Collection ID
    tokenId: string;     // Token ID within the collection
    seller: string;      // Seller's address
    buyer: string;       // Buyer's address
    price: string | bigint;       // Sale price in payment token
    paymentToken: {      // Token used for payment
        symbol: string;
        issuer: string;
    };
    royaltyAmount?: string | bigint;  // Amount paid as royalty
    timestamp: string;    // ISO date string
}

export interface NftListPayload {
  collectionSymbol: string;
  instanceId: string;
  price: string; // Changed from number to string, expecting stringified BigInt
  paymentTokenSymbol: string; // Token for payment
  paymentTokenIssuer?: string; // Required if paymentTokenSymbol is not NATIVE_TOKEN
}

export interface NftDelistPayload {
  listingId: string; // The ID of the listing to remove
  // Alternative: collectionSymbol + instanceId if only one active listing per NFT is allowed
  // collectionSymbol: string;
  // instanceId: string;
}

export interface NftBuyPayload {
  listingId: string; // The ID of the listing to buy
  // Buyer might offer a different price if it were an auction/offer system, but for direct buy, listingId is key.
  // paymentTokenSymbol and paymentTokenIssuer are implied by the listing.
}

// Event interfaces for market activities could also be defined here later.
// export interface NftItemListedEvent { ... }
// export interface NftItemSoldEvent { ... }
// export interface NftItemDelistedEvent { ... } 