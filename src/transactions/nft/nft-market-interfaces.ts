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
    paymentToken: string;
    status: 'ACTIVE' | 'SOLD' | 'CANCELLED' | 'ENDED';
    expiration?: string;
    createdAt: string;
    lastUpdatedAt?: string;
    listingType?: 'FIXED_PRICE' | 'AUCTION' | 'RESERVE_AUCTION';
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
    price: string | bigint;
    paymentToken: string;
    listingType?: 'FIXED_PRICE' | 'AUCTION' | 'RESERVE_AUCTION';
    reservePrice?: string;
    auctionEndTime?: string;
    allowBuyNow?: boolean;
    minimumBidIncrement?: string | bigint;
}

export interface NftDelistPayload {
    listingId: string;
}

export interface NftBuyPayload {
    listingId: string;
    bidAmount?: string;
    bidType?: 'FULL_PRICE' | 'BID';
}

export interface NftBid {
    _id: string;
    listingId: string;
    bidder: string;
    bidAmount: string | bigint;
    status: 'ACTIVE' | 'OUTBID' | 'WINNING' | 'WON' | 'LOST' | 'CANCELLED' | 'EXPIRED';
    paymentToken: string;
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
    operation: 'LIST' | 'DELIST' | 'BUY' | 'BID' | 'TRANSFER';
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
    targetType: 'NFT' | 'COLLECTION' | 'TRAIT';
    targetId: string;
    offerBy: string;
    offerAmount: string | bigint;
    paymentToken:  string;
    status: 'ACTIVE' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED';
    expiresAt?: string;
    createdAt: string;
    escrowedAmount: string | bigint;
    traits?: {
        [key: string]: string;
    };
    floorPrice?: string | bigint;
}

export interface NftMakeOfferData {
    targetType: 'NFT' | 'COLLECTION' | 'TRAIT';
    targetId: string;
    offerAmount: string;
    paymentToken: string;
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
