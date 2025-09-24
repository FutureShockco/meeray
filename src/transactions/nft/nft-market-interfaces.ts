export interface NFTListingCreateData {
    collectionId: string;
    tokenId: string;
    price: string | bigint;
    paymentToken: {
        symbol: string;
        issuer: string;
    };
    expiration?: string;
}

export interface NFTListingCancelData {
    listingId: string;
}

export interface NFTListingPurchaseData {
    listingId: string;
    buyer: string;
}

export interface NFTListingData {
    _id: string;
    collectionId: string;
    tokenId: string;
    seller: string;
    price: string | bigint;
    paymentToken: {
        symbol: string;
        issuer?: string;
    };
    status: 'active' | 'sold' | 'cancelled' | 'ended';
    expiration?: string;
    createdAt: string;
    lastUpdatedAt?: string;
    listingType?: 'fixed_price' | 'auction' | 'reserve_auction';
    reservePrice?: string | bigint;
    auctionEndTime?: string;
    allowBuyNow?: boolean;
    minimumBidIncrement?: string | bigint;
    currentHighestBid?: string | bigint;
    currentHighestBidder?: string;
    totalBids?: number;
}

export interface NFTSaleData {
    _id: string;
    listingId: string;
    collectionId: string;
    tokenId: string;
    seller: string;
    buyer: string;
    price: string | bigint;
    paymentToken: {
        symbol: string;
        issuer: string;
    };
    royaltyAmount?: string | bigint;
    timestamp: string;
}

export interface NftListPayload {
    collectionSymbol: string;
    instanceId: string;
    price: string;
    paymentTokenSymbol: string;
    paymentTokenIssuer?: string;
    listingType?: 'fixed_price' | 'auction' | 'reserve_auction';
    reservePrice?: string;
    auctionEndTime?: string;
    allowBuyNow?: boolean;
    minimumBidIncrement?: string;
}

export interface NftDelistPayload {
    listingId: string;
}

export interface NftBuyPayload {
    listingId: string;
    bidAmount?: string;
    bidType?: 'full_price' | 'bid';
}

export interface NftBid {
    _id: string;
    listingId: string;
    bidder: string;
    bidAmount: string | bigint;
    status: 'active' | 'outbid' | 'winning' | 'won' | 'lost' | 'cancelled' | 'expired';
    paymentToken: {
        symbol: string;
        issuer?: string;
    };
    escrowedAmount: string | bigint;
    createdAt: string;
    expiresAt?: string;
    isHighestBid: boolean;
    previousHighBidId?: string;
    autoExtendTime?: number;
}

export interface NftAcceptBidData {
    bidId: string;
    listingId: string;
}

export interface CloseAuctionData {
    listingId: string;
    winningBidId?: string;
    force?: boolean;
}

export interface NftBatchOperation {
    operation: 'list' | 'delist' | 'buy' | 'bid' | 'transfer';
    data: NftListPayload | NftDelistPayload | NftBuyPayload | any;
}

export interface NftBatchPayload {
    operations: NftBatchOperation[];
    atomic?: boolean;
}

export interface NftCancelBidData {
    bidId: string;
    listingId: string;
}

export interface NftOffer {
    _id: string;
    targetType: 'nft' | 'collection' | 'trait';
    targetId: string;
    offerBy: string;
    offerAmount: string | bigint;
    paymentToken: {
        symbol: string;
        issuer?: string;
    };
    status: 'active' | 'accepted' | 'expired' | 'cancelled';
    expiresAt?: string;
    createdAt: string;
    escrowedAmount: string | bigint;
    traits?: {
        [key: string]: string;
    };
    floorPrice?: string | bigint;
}

export interface NftMakeOfferData {
    targetType: 'nft' | 'collection' | 'trait';
    targetId: string;
    offerAmount: string;
    paymentTokenSymbol: string;
    paymentTokenIssuer?: string;
    expiresAt?: string;
    traits?: {
        [key: string]: string;
    };
    floorPrice?: string;
}

export interface NftAcceptOfferData {
    offerId: string;
    nftInstanceId?: string;
}

export interface NftCancelOfferData {
    offerId: string;
}

