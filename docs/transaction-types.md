# Echelon Blockchain Transaction Types

This document provides a comprehensive list of all transaction types implemented in the Echelon blockchain, including their data structures and purposes.

## 1. NFT Transactions

### NFT Create Collection (Type 1)
- **File**: `src/transactions/nft/nft-create-collection.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
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
  ```

### NFT Mint (Type 2)
- **File**: `src/transactions/nft/nft-mint.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface NftMintData {
    collectionSymbol: string; // Symbol of the collection to mint into
    instanceId?: string;      // Optional: User-defined ID for the NFT (unique within collection). If not provided, will be auto-generated (e.g., UUID).
    owner: string;            // Account name of the new NFT owner
    properties?: Record<string, any>; // NFT instance-specific properties
    // immutableProperties?: boolean; // If true, instance properties cannot be changed. Default false.
    uri?: string;             // URI pointing to off-chain metadata or asset (max 2048 chars)
  }
  ```

### NFT Transfer (Type 3)
- **File**: `src/transactions/nft/nft-transfer.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface NftTransferData {
    collectionSymbol: string;
    instanceId: string;       // ID of the NFT instance to transfer
    to: string;               // Account name of the new owner
    memo?: string;             // Optional memo (max 256 chars)
  }
  ```

### NFT List Item (Type 4)
- **File**: `src/transactions/nft/nft-list-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface NftListPayload {
    collectionSymbol: string;
    instanceId: string;
    price: number; // Sale price
    paymentTokenSymbol: string; // Token for payment
    paymentTokenIssuer?: string; // Required if paymentTokenSymbol is not NATIVE_TOKEN
  }
  ```

### NFT Delist Item (Type 5)
- **File**: `src/transactions/nft/nft-delist-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface NftDelistPayload {
    listingId: string; // The ID of the listing to remove
    // Alternative: collectionSymbol + instanceId if only one active listing per NFT is allowed
    // collectionSymbol: string;
    // instanceId: string;
  }
  ```

### NFT Buy Item (Type 6)
- **File**: `src/transactions/nft/nft-buy-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface NftBuyPayload {
    listingId: string; // The ID of the listing to buy
    // Buyer might offer a different price if it were an auction/offer system, but for direct buy, listingId is key.
    // paymentTokenSymbol and paymentTokenIssuer are implied by the listing.
  }
  ```

### NftListing
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Represents an NFT listed on the market.
- **Data Structure**:
  ```typescript
  export interface NftListing {
    _id: string;
    collectionSymbol: string;
    instanceId: string;
    seller: string;
    price: number;
    paymentTokenSymbol: string;
    paymentTokenIssuer?: string;
    listedAt: string;
    status: 'ACTIVE' | 'SOLD' | 'CANCELLED';
  }
  ```

### NftListPayload
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Payload for listing an NFT.
- **Data Structure**:
  ```typescript
  export interface NftListPayload {
    collectionSymbol: string;
    instanceId: string;
    price: number; // Sale price
    paymentTokenSymbol: string; // Token for payment
    paymentTokenIssuer?: string; // Required if paymentTokenSymbol is not NATIVE_TOKEN
  }
  ```

### NftDelistPayload
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Payload for delisting an NFT.
- **Data Structure**:
  ```typescript
  export interface NftDelistPayload {
    listingId: string; // The ID of the listing to remove
    // Alternative: collectionSymbol + instanceId if only one active listing per NFT is allowed
    // collectionSymbol: string;
    // instanceId: string;
  }
  ```

### NftBuyPayload
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Payload for buying an NFT.
- **Data Structure**:
  ```typescript
  export interface NftBuyPayload {
    listingId: string; // The ID of the listing to buy
    // Buyer might offer a different price if it were an auction/offer system, but for direct buy, listingId is key.
    // paymentTokenSymbol and paymentTokenIssuer are implied by the listing.
  }
  ```

### NftUpdateMetadataData
- **File**: `src/transactions/nft/nft-interfaces.ts`
- **Purpose**: Data for updating NFT metadata.
- **Data Structure**:
  ```typescript
  export interface NftUpdateMetadataData {
    collectionSymbol: string;
    instanceId: string;
    properties?: Record<string, any>;
    uri?: string;
  }
  ```

## 2. Market Transactions

### Market Create Pair (Type 7)
- **File**: `src/transactions/market/market-create-pair.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface MarketCreatePairData {
    baseAssetSymbol: string;
    baseAssetIssuer: string;
    quoteAssetSymbol: string;
    quoteAssetIssuer: string;
    tickSize: number;
    lotSize: number;
    minNotional: number;
    initialStatus?: string; // Default to 'TRADING' or 'PRE_TRADE'
  }
  ```

### Market Place Order (Type 8)
- **File**: `src/transactions/market/market-place-order.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface MarketPlaceOrderData {
    userId: string; // Will be sender
    pairId: string;
    type: OrderType;
    side: OrderSide;
    price?: number; // Required for LIMIT
    quantity: number;
    quoteOrderQty?: number; // For MARKET BUY by quote amount
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    // clientOrderId?: string;
  }
  ```

### Market Cancel Order (Type 9)
- **File**: `src/transactions/market/market-cancel-order.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface MarketCancelOrderData {
    userId: string; // Will be sender
    orderId: string;
    pairId: string; // Useful for routing/sharding if books are managed per pair
  }
  ```

### TradingPair
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents a trading pair in the market.
- **Data Structure**:
  ```typescript
  export interface TradingPair {
    _id: string;
    baseAssetSymbol: string;
    baseAssetIssuer: string;
    quoteAssetSymbol: string;
    quoteAssetIssuer: string;
    tickSize: number;
    lotSize: number;
    minNotional: number;
    status: string;
    createdAt: string;
  }
  ```

### Order
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents an order in the market.
- **Data Structure**:
  ```typescript
  export interface Order {
    _id: string;
    userId: string;
    pairId: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    type: OrderType;
    side: OrderSide;
    status: OrderStatus;
    price?: number;
    quantity: number;
    filledQuantity: number;
    averageFillPrice?: number;
    cumulativeQuoteValue?: number;
    quoteOrderQty?: number;
    createdAt: string;
    updatedAt: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    expiresAt?: string;
  }
  ```

### Trade
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents a trade executed in the market.
- **Data Structure**:
  ```typescript
  export interface Trade {
    _id: string;
    pairId: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    makerOrderId: string;
    takerOrderId: string;
    price: number;
    quantity: number;
    buyerUserId: string;
    sellerUserId: string;
    timestamp: string;
    isMakerBuyer: boolean;
    feeAmount?: number;
    feeCurrency?: string;
  }
  ```

### OrderBookLevel
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents a level in the order book.
- **Data Structure**:
  ```typescript
  export interface OrderBookLevel {
    price: number;
    quantity: number;
    orderCount?: number;
  }
  ```

### OrderBookSnapshot
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: A snapshot of the order book.
- **Data Structure**:
  ```typescript
  export interface OrderBookSnapshot {
    pairId: string;
    timestamp: string;
    lastUpdateId?: number;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  }
  ```

## 3. Farm Transactions

### Farm Create (Type 10)
- **File**: `src/transactions/farm/farm-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface FarmCreateData {
    lpTokenSymbol: string;      // Symbol of the LP token that will be staked (e.g., "TKA/TKB-LP")
    lpTokenIssuer: string;      // Issuer of the LP token
    rewardTokenSymbol: string;  // Symbol of the token given as reward
    rewardTokenIssuer: string;  // Issuer of the reward token
    // farmId will be generated, e.g., hash(lpTokenSymbol, lpTokenIssuer, rewardTokenSymbol, rewardTokenIssuer)
    // rewardRate: number; // Amount of rewardToken per second/block/period. This is complex and needs careful design for distribution.
    // startBlock/startTime: number; // Block or time when farming starts
    // endBlock/endTime: number;   // Block or time when farming ends (or if it's perpetual)
    // For simplicity, let's assume rewards are manually distributed or handled by a simpler periodic mechanism initially.
  }
  ```

### Farm Stake (Type 11)
- **File**: `src/transactions/farm/farm-stake.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface FarmStakeData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account staking the LP tokens (sender)
    lpTokenAmount: number;      // Amount of LP tokens to stake
  }
  ```

### Farm Unstake (Type 12)
- **File**: `src/transactions/farm/farm-unstake.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface FarmUnstakeData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account unstaking the LP tokens (sender)
    lpTokenAmount: number;      // Amount of LP tokens to unstake
    // withdrawRewards: boolean; // Default true, also claim pending rewards
  }
  ```

### Farm Claim Rewards (Type 13)
- **File**: `src/transactions/farm/farm-claim-rewards.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface FarmClaimRewardsData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account claiming rewards (sender)
  }
  ```

## 4. Pool Transactions

### Pool Create (Type 14)
- **File**: `src/transactions/pool/pool-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface PoolCreateData {
    tokenA_symbol: string;      // Symbol of the first token in the pair
    tokenA_issuer: string;      // Issuer account of the first token
    tokenB_symbol: string;      // Symbol of the second token in the pair
    tokenB_issuer: string;      // Issuer account of the second token
    feeTier?: number;           // Optional: e.g., 5 (0.05%), 30 (0.3%), 100 (1%). In basis points.
  }
  ```

### Pool Add Liquidity (Type 15)
- **File**: `src/transactions/pool/pool-add-liquidity.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface PoolAddLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    provider: string;           // Account providing the liquidity (sender of the transaction)
    tokenA_amount: number;      // Amount of token A to add
    tokenB_amount: number;      // Amount of token B to add (must respect pool ratio, or be first provider)
  }
  ```

### Pool Remove Liquidity (Type 16)
- **File**: `src/transactions/pool/pool-remove-liquidity.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface PoolRemoveLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    provider: string;           // Account removing the liquidity (sender of the transaction)
    lpTokenAmount: number;      // Amount of LP (Liquidity Provider) tokens to burn/redeem
  }
  ```

### Pool Swap (Type 17)
- **File**: `src/transactions/pool/pool-swap.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface PoolSwapData {
    trader: string;             // Account performing the swap (sender of the transaction)
    amountIn: string;           // Amount of initial token to swap (as a string to preserve precision)
    minAmountOut: string;       // Minimum amount of final token expected (as a string, for slippage protection)
    poolId?: string;            // Identifier of the liquidity pool to swap through (for direct swap)
    tokenInSymbol?: string;     // Symbol of the token being sold (for direct swap)
    tokenInIssuer?: string;     // Issuer of the token being sold (for direct swap)
    tokenOutSymbol?: string;    // Symbol of the token being bought (for direct swap)
    tokenOutIssuer?: string;    // Issuer of the token being bought (for direct swap)
    fromTokenSymbol?: string;   // Overall input token symbol for a routed swap
    fromTokenIssuer?: string;   // Overall input token issuer for a routed swap
    toTokenSymbol?: string;     // Overall output token symbol for a routed swap
    toTokenIssuer?: string;     // Overall output token issuer for a routed swap
    hops?: Array<{
      poolId: string;
      hopTokenInSymbol: string;
      hopTokenInIssuer: string;
      hopTokenOutSymbol: string;
      hopTokenOutIssuer: string;
    }>;
  }
  ```

## 5. Token Transactions

### Token Create (Type 18)
- **File**: `src/transactions/token/token-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface TokenCreateData {
    symbol: string;
    name: string;
    precision: number;
    maxSupply: number;
    initialSupply?: number;
    mintable?: boolean;
    burnable?: boolean;
    description?: string;
    logoUrl?: string;
    websiteUrl?: string;
  }
  ```

### Token Mint (Type 19)
- **File**: `src/transactions/token/token-mint.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface TokenMintData {
    symbol: string;
    to: string;
    amount: number;
  }
  ```

### Token Transfer (Type 20)
- **File**: `src/transactions/token/token-transfer.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface TokenTransferData {
    symbol: string;
    to: string;
    amount: number;
    memo?: string;
  }
  ```

### Token Update (Type 21)
- **File**: `src/transactions/token/token-update.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface TokenUpdateData {
    symbol: string;
    name?: string;
    description?: string;
    logoUrl?: string;
    websiteUrl?: string;
  }
  ```

## 6. Witness Transactions

### Witness Register (Type 22)
- **File**: `src/transactions/witness/witness-register.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface WitnessRegisterData {
    pub: string;
  }
  ```

### Witness Vote (Type 23)
- **File**: `src/transactions/witness/witness-vote.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface WitnessVoteData {
    target: string;
  }
  ```

### Witness Unvote (Type 24)
- **File**: `src/transactions/witness/witness-unvote.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface WitnessUnvoteData {
    target: string;
  }
  ```

## 7. Launchpad Transactions

### Launchpad Launch Token (Type 25)
- **File**: `src/transactions/launchpad/launchpad-launch-token.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface LaunchpadLaunchTokenData {
    userId: string;
    tokenName: string;
    tokenSymbol: string;
    tokenStandard: TokenStandard; // From launchpad-interfaces.ts (NATIVE, WRAPPED_NATIVE_LIKE)
    tokenDescription?: string;
    tokenLogoUrl?: string;
    projectWebsite?: string;
    projectSocials?: { [platform: string]: string };
    tokenomics: Tokenomics; // From launchpad-interfaces.ts
    presaleDetails?: PresaleDetails; // From launchpad-interfaces.ts
    liquidityProvisionDetails?: LiquidityProvisionDetails; // From launchpad-interfaces.ts
    launchFeeTokenSymbol: string;
    launchFeeTokenIssuer?: string;
  }
  ```

### Launchpad Participate Presale (Type 26)
- **File**: `src/transactions/launchpad/launchpad-participate-presale.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface LaunchpadParticipatePresaleData {
    userId: string;
    launchpadId: string;
    contributionAmount: number;
  }
  ```

### Launchpad Claim Tokens (Type 27)
- **File**: `src/transactions/launchpad/launchpad-claim-tokens.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  export interface LaunchpadClaimTokensData {
    userId: string;
    launchpadId: string;
    allocationType: TokenDistributionRecipient; // From launchpad-interfaces.ts
  }
  ```

## 8. Other Core Interfaces

### VestingSchedule
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Defines the vesting schedule for tokens.
- **Data Structure**:
  ```typescript
  interface VestingSchedule {
    type: VestingType; // e.g., NONE, LINEAR_MONTHLY
    cliffMonths?: number;
    durationMonths: number;
    initialUnlockPercentage?: number;
  }
  ```

### TokenAllocation
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Describes how tokens are allocated to different recipients.
- **Data Structure**:
  ```typescript
  interface TokenAllocation {
    recipient: TokenDistributionRecipient; // e.g., PROJECT_TEAM, ADVISORS
    percentage: number;
    vestingSchedule?: VestingSchedule;
    lockupMonths?: number;
    customRecipientAddress?: string;
  }
  ```

### Tokenomics
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Defines the overall tokenomics of a project.
- **Data Structure**:
  ```typescript
  interface Tokenomics {
    totalSupply: number;
    tokenDecimals: number;
    allocations: TokenAllocation[];
  }
  ```

### PresaleDetails
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Contains details about a token presale.
- **Data Structure**:
  ```typescript
  interface PresaleDetails {
    presaleTokenAllocationPercentage: number;
    pricePerToken: number;
    quoteAssetForPresaleSymbol: string;
    quoteAssetForPresaleIssuer?: string;
    minContributionPerUser: number;
    maxContributionPerUser: number;
    startTime: string;
    endTime: string;
    hardCap: number;
    softCap?: number;
    whitelistRequired?: boolean;
    fcfsAfterReservedAllocation?: boolean;
  }
  ```

### LiquidityProvisionDetails
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Details for providing liquidity to a DEX.
- **Data Structure**:
  ```typescript
  interface LiquidityProvisionDetails {
    dexIdentifier: string;
    liquidityTokenAllocationPercentage: number;
    quoteAssetForLiquiditySymbol: string;
    quoteAssetForLiquidityIssuer?: string;
    initialQuoteAmountProvidedByProject?: number;
    lpTokenLockupMonths?: number;
  }
  ```

### Token (Launchpad)
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Represents a token within the launchpad system.
- **Data Structure**:
  ```typescript
  interface Token {
    _id: string;
    name: string;
    symbol: string;
    standard: TokenStandard;
    decimals: number;
    totalSupply: number;
    maxSupply?: number;
    owner: string;
    description?: string;
    logoUrl?: string;
    website?: string;
    socials?: { [platform: string]: string };
    createdAt: string;
    launchpadId: string;
  }
  ```

### Launchpad
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Represents a launchpad project in the system.
- **Data Structure**:
  ```typescript
  interface Launchpad {
    _id: string;
    projectId: string;
    status: LaunchpadStatus;
    tokenToLaunch: {
      name: string;
      symbol: string;
      standard: TokenStandard;
      decimals: number;
      totalSupply: number;
    };
    tokenomicsSnapshot: Tokenomics;
    presaleDetailsSnapshot?: PresaleDetails;
    liquidityProvisionDetailsSnapshot?: LiquidityProvisionDetails;
    launchedByUserId: string;
    createdAt: string;
    updatedAt: string;
    presale?: {
      startTimeActual?: string;
      endTimeActual?: string;
      totalQuoteRaised: number;
      participants: Array<{
        userId: string;
        quoteAmountContributed: number;
        tokensAllocated?: number;
        claimed: boolean;
      }>;
      status: 'NOT_STARTED' | 'ACTIVE' | 'ENDED_PENDING_CLAIMS' | 'ENDED_CLAIMS_PROCESSED' | 'FAILED';
    };
    mainTokenId?: string;
    dexPairAddress?: string;
    feePaid: boolean;
    feeDetails?: {
      tokenSymbol: string;
      tokenIssuer?: string;
      amount: number;
    };
    relatedTxIds?: string[];
  }
  ```

### LiquidityPool
- **File**: `src/transactions/pool/pool-interfaces.ts`
- **Purpose**: Represents a liquidity pool.
- **Data Structure**:
  ```typescript
  export interface LiquidityPool {
    _id: string;
    tokenA_symbol: string;
    tokenA_issuer: string;
    tokenA_reserve: number;
    tokenB_symbol: string;
    tokenB_issuer: string;
    tokenB_reserve: number;
    totalLpTokens: number;
    lpTokenSymbol: string;
    feeRate: number;
    createdAt: string;
    lastUpdatedAt?: string;
  }
  ```

### UserLiquidityPosition
- **File**: `src/transactions/pool/pool-interfaces.ts`
- **Purpose**: Represents a user's position in a liquidity pool.
- **Data Structure**:
  ```typescript
  export interface UserLiquidityPosition {
    _id: string;
    provider: string;
    poolId: string;
    lpTokenBalance: number;
    createdAt: string;
    lastUpdatedAt?: string;
  }
  ```

### Farm
- **File**: `src/transactions/farm/farm-interfaces.ts`
- **Purpose**: Represents a farm.
- **Data Structure**:
  ```typescript
  export interface Farm {
    _id: string;
    lpTokenSymbol: string;
    lpTokenIssuer: string;
    rewardTokenSymbol: string;
    rewardTokenIssuer: string;
    totalLpStaked: number;
    createdAt: string;
  }
  ```

### UserFarmPosition