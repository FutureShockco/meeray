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
    price: string | bigint;        // Starting price OR fixed price
    paymentToken: {       // Token accepted as payment
        symbol: string;
        issuer?: string;    // Made issuer optional
    };
    status: 'active' | 'sold' | 'cancelled' | 'ended';
    expiration?: string;  // ISO date string for listing expiration
    createdAt: string;
    lastUpdatedAt?: string;
    
    // NEW AUCTION FIELDS:
    listingType?: 'FIXED_PRICE' | 'AUCTION' | 'RESERVE_AUCTION';
    reservePrice?: string | bigint;            // Minimum acceptable bid
    auctionEndTime?: string;                   // When auction closes
    allowBuyNow?: boolean;                     // Allow instant purchase during auction
    minimumBidIncrement?: string | bigint;     // Minimum bid increase
    currentHighestBid?: string | bigint;       // Current highest bid amount
    currentHighestBidder?: string;             // Current highest bidder
    totalBids?: number;                        // Total number of bids placed
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
  price: string; // Starting price OR fixed price
  paymentTokenSymbol: string; // Token for payment
  paymentTokenIssuer?: string; // Required if paymentTokenSymbol is not NATIVE_TOKEN
  
  // NEW AUCTION FIELDS:
  listingType?: 'FIXED_PRICE' | 'AUCTION' | 'RESERVE_AUCTION';
  reservePrice?: string;            // Minimum acceptable bid (for reserve auctions)
  auctionEndTime?: string;          // When auction closes (ISO string)
  allowBuyNow?: boolean;            // Allow instant purchase during auction
  minimumBidIncrement?: string;     // Minimum amount each bid must increase by
}

export interface NftDelistPayload {
  listingId: string; // The ID of the listing to remove
  // Alternative: collectionSymbol + instanceId if only one active listing per NFT is allowed
  // collectionSymbol: string;
  // instanceId: string;
}

export interface NftBuyPayload {
  listingId: string; // The ID of the listing to buy
  bidAmount?: string; // NEW: Optional bid amount (if different from listing price)
  bidType?: 'FULL_PRICE' | 'BID'; // NEW: Explicit bid type
}

// NEW BIDDING INTERFACES

export interface NftBid {
  _id: string;                    // bidId: hash(listingId, bidder, timestamp)
  listingId: string;              // Reference to the NFT listing
  bidder: string;                 // Who made the bid
  bidAmount: string | bigint;     // Bid amount
  status: 'ACTIVE' | 'OUTBID' | 'WINNING' | 'WON' | 'LOST' | 'CANCELLED' | 'EXPIRED';
  paymentToken: {                 // Same as listing payment token
    symbol: string;
    issuer?: string;
  };
  escrowedAmount: string | bigint; // Amount locked in buyer's account
  createdAt: string;              // When bid was made
  expiresAt?: string;             // Optional bid expiration
  isHighestBid: boolean;          // Track if this is currently the highest bid
  previousHighBidId?: string;     // Reference to bid this outbid
  autoExtendTime?: number;        // Seconds to extend auction if bid in last minutes
}

// Accept bid transaction payload
export interface NftAcceptBidData {
  bidId: string;                  // Which bid to accept
  listingId: string;              // Validation - ensure seller owns listing
}

// Close auction transaction payload  
export interface CloseAuctionData {
  listingId: string;              // Which auction to close
  winningBidId?: string;          // Optional: specify winning bid (auto-detect if not provided)
  force?: boolean;                // Force close even if auction time hasn't ended
}

// Batch operations interface
export interface NftBatchOperation {
  operation: 'LIST' | 'DELIST' | 'BUY' | 'BID' | 'TRANSFER';
  data: NftListPayload | NftDelistPayload | NftBuyPayload | any;
}

export interface NftBatchPayload {
  operations: NftBatchOperation[];
  atomic?: boolean;               // If true, all operations must succeed or all fail
}

// Cancel bid transaction payload
export interface NftCancelBidData {
  bidId: string;                  // Which bid to cancel
  listingId: string;              // Validation - ensure bidder owns bid
}

// Offer interfaces (for unlisted NFTs or collection offers)
export interface NftOffer {
  _id: string;                    // offerId: hash(target, offerBy, timestamp)
  targetType: 'NFT' | 'COLLECTION' | 'TRAIT';
  targetId: string;               // NFT instance ID, collection symbol, or trait combination
  offerBy: string;                // Who made the offer
  offerAmount: string | bigint;   // Offer amount
  paymentToken: {
    symbol: string;
    issuer?: string;
  };
  status: 'ACTIVE' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED';
  expiresAt?: string;             // When offer expires
  createdAt: string;              // When offer was made
  escrowedAmount: string | bigint; // Amount locked in offerBy's account
  traits?: {                      // For trait-based offers
    [key: string]: string;
  };
  floorPrice?: string | bigint;   // For collection offers - minimum floor
}

// Make offer transaction payload
export interface NftMakeOfferData {
  targetType: 'NFT' | 'COLLECTION' | 'TRAIT';
  targetId: string;               // NFT instance ID or collection symbol
  offerAmount: string;            // Offer amount
  paymentTokenSymbol: string;     // Token for payment
  paymentTokenIssuer?: string;    // Required if not native token
  expiresAt?: string;             // Optional expiration
  traits?: {                      // For trait-based offers
    [key: string]: string;
  };
  floorPrice?: string;            // For collection offers
}

// Accept offer transaction payload
export interface NftAcceptOfferData {
  offerId: string;                // Which offer to accept
  nftInstanceId?: string;         // Required for collection/trait offers
}

// Cancel offer transaction payload
export interface NftCancelOfferData {
  offerId: string;                // Which offer to cancel
}

// Event interfaces for market activities could also be defined here later.
// export interface NftItemListedEvent { ... }
// export interface NftItemSoldEvent { ... }
// export interface NftItemDelistedEvent { ... } 