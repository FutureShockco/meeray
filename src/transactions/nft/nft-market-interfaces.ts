import { OrderSide } from '../market/market-interfaces.js'; // Potentially for buy/sell side if making it more generic later

export interface NftListing {
  _id: string; // Unique ID for the listing (e.g., collectionSymbol-instanceId-listerAddress or a UUID)
  collectionSymbol: string;
  instanceId: string;
  seller: string; // Account address of the seller
  price: number; // Sale price
  paymentTokenSymbol: string; // Symbol of the token for payment (e.g., "NATIVE_TOKEN", "USDC")
  paymentTokenIssuer?: string; // Issuer for non-native tokens
  listedAt: string; // ISO Date string when the item was listed
  status: 'ACTIVE' | 'SOLD' | 'CANCELLED';
}

export interface NftListPayload {
  collectionSymbol: string;
  instanceId: string;
  price: number; // Sale price
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