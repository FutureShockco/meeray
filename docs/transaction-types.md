# Echelon Blockchain Transaction Types

This document provides a comprehensive list of all transaction types implemented in the Echelon blockchain, including their data structures and purposes.

## 1. NFT Transactions

### 1.1 NFT Collection Management

#### NFT Create Collection
- **File**: `src/transactions/nft/nft-create-collection.ts`
- **Purpose**: Creates a new NFT collection with metadata
- **Data Structure**:
  ```typescript
  interface NftCreateCollectionData {
    symbol: string;       // Unique identifier for the collection
    name: string;         // Human-readable name for the collection
    allowDelegation: boolean; // Whether NFTs in this collection can be delegated
    metadata: string;     // JSON metadata about the collection
  }
  ```

#### NFT Mint
- **File**: `src/transactions/nft/nft-mint.ts`
- **Purpose**: Mints a new NFT instance in a collection
- **Data Structure**:
  ```typescript
  interface NftMintData {
    collectionSymbol: string; // Symbol of the collection to mint in
    toAccount: string;        // Account to receive the NFT
    metadata: string;         // JSON metadata for the NFT instance
    properties: string;       // JSON properties for the NFT instance
  }
  ```

#### NFT Transfer
- **File**: `src/transactions/nft/nft-transfer.ts`
- **Purpose**: Transfers an NFT from one account to another
- **Data Structure**:
  ```typescript
  interface NftTransferData {
    collectionSymbol: string; // Symbol of the collection
    instanceId: string;       // Identifier of the NFT instance
    to: string;               // Recipient account
  }
  ```

### 1.2 NFT Marketplace

#### NFT List Item
- **File**: `src/transactions/nft/nft-list-item.ts`
- **Purpose**: Lists an NFT for sale on the marketplace
- **Data Structure**:
  ```typescript
  interface NftListItemData {
    collectionSymbol: string; // Symbol of the collection
    instanceId: string;       // Identifier of the NFT instance
    price: number;            // Sale price
    priceSymbol: string;      // Symbol of the token for payment
    expiration?: number;      // Optional expiration timestamp
  }
  ```

#### NFT Delist Item
- **File**: `src/transactions/nft/nft-delist-item.ts`
- **Purpose**: Removes an NFT listing from the marketplace
- **Data Structure**:
  ```typescript
  interface NftDelistItemData {
    collectionSymbol: string; // Symbol of the collection
    instanceId: string;       // Identifier of the NFT instance
  }
  ```

#### NFT Buy Item
- **File**: `src/transactions/nft/nft-buy-item.ts`
- **Purpose**: Purchases a listed NFT
- **Data Structure**:
  ```typescript
  interface NftBuyItemData {
    collectionSymbol: string; // Symbol of the collection
    instanceId: string;       // Identifier of the NFT instance
  }
  ```

## 2. Market Transactions

#### Market Create Pair
- **File**: `src/transactions/market/market-create-pair.ts`
- **Purpose**: Creates a new trading pair
- **Data Structure**:
  ```typescript
  interface MarketCreatePairData {
    baseAssetSymbol: string;   // Symbol of the base asset
    baseAssetIssuer: string;   // Issuer of the base asset
    quoteAssetSymbol: string;  // Symbol of the quote asset
    quoteAssetIssuer: string;  // Issuer of the quote asset
  }
  ```

#### Market Place Order
- **File**: `src/transactions/market/market-place-order.ts`
- **Purpose**: Places a buy or sell order on a trading pair
- **Data Structure**:
  ```typescript
  interface MarketPlaceOrderData {
    pairId: string;             // Identifier of the trading pair
    userId: string;             // User placing the order
    type: OrderType;            // LIMIT or MARKET
    side: OrderSide;            // BUY or SELL
    price?: number;             // Required for LIMIT orders
    quantity: number;           // Amount of base asset
    quoteOrderQty?: number;     // Optional: quote asset quantity for MARKET BUY
    timeInForce?: string;       // GTC, IOC, FOK (default: GTC)
  }

  enum OrderType {
    LIMIT = 'LIMIT',
    MARKET = 'MARKET'
  }

  enum OrderSide {
    BUY = 'BUY',
    SELL = 'SELL'
  }
  ```

#### Market Cancel Order
- **File**: `src/transactions/market/market-cancel-order.ts`
- **Purpose**: Cancels an existing order
- **Data Structure**:
  ```typescript
  interface MarketCancelOrderData {
    orderId: string;           // Identifier of the order
    pairId: string;            // Identifier of the trading pair
    userId: string;            // User cancelling the order
  }
  ```

## 3. Farm Transactions

#### Farm Create
- **File**: `src/transactions/farm/farm-create.ts`
- **Purpose**: Creates a new yield farm for an LP token
- **Data Structure**:
  ```typescript
  interface FarmCreateData {
    lpTokenSymbol: string;      // Symbol of the LP token to be staked
    lpTokenIssuer: string;      // Issuer of the LP token
    rewardTokenSymbol: string;  // Symbol of the token given as reward
    rewardTokenIssuer: string;  // Issuer of the reward token
  }
  ```

#### Farm Stake
- **File**: `src/transactions/farm/farm-stake.ts`
- **Purpose**: Stakes LP tokens in a farm to earn rewards
- **Data Structure**:
  ```typescript
  interface FarmStakeData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account staking the LP tokens
    lpTokenAmount: number;      // Amount of LP tokens to stake
  }
  ```

#### Farm Unstake
- **File**: `src/transactions/farm/farm-unstake.ts`
- **Purpose**: Withdraws LP tokens from a farm
- **Data Structure**:
  ```typescript
  interface FarmUnstakeData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account unstaking the LP tokens
    lpTokenAmount: number;      // Amount of LP tokens to unstake
  }
  ```

#### Farm Claim Rewards
- **File**: `src/transactions/farm/farm-claim-rewards.ts`
- **Purpose**: Claims earned rewards from a farm
- **Data Structure**:
  ```typescript
  interface FarmClaimRewardsData {
    farmId: string;             // Identifier of the farm
    staker: string;             // Account claiming rewards
  }
  ```

## 4. Pool Transactions

#### Pool Create
- **File**: `src/transactions/pool/pool-create.ts`
- **Purpose**: Creates a new liquidity pool
- **Data Structure**:
  ```typescript
  interface PoolCreateData {
    tokenA_symbol: string;      // Symbol of the first token in the pair
    tokenA_issuer: string;      // Issuer account of the first token
    tokenB_symbol: string;      // Symbol of the second token in the pair
    tokenB_issuer: string;      // Issuer account of the second token
    feeTier?: number;           // Optional: fee tier in basis points (e.g., 30 for 0.3%)
  }
  ```

#### Pool Add Liquidity
- **File**: `src/transactions/pool/pool-add-liquidity.ts`
- **Purpose**: Adds tokens to a liquidity pool
- **Data Structure**:
  ```typescript
  interface PoolAddLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    provider: string;           // Account providing the liquidity
    tokenA_amount: number;      // Amount of token A to add
    tokenB_amount: number;      // Amount of token B to add
  }
  ```

#### Pool Remove Liquidity
- **File**: `src/transactions/pool/pool-remove-liquidity.ts`
- **Purpose**: Removes liquidity from a pool
- **Data Structure**:
  ```typescript
  interface PoolRemoveLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    provider: string;           // Account removing the liquidity
    lpTokenAmount: number;      // Amount of LP tokens to burn/redeem
  }
  ```

#### Pool Swap
- **File**: `src/transactions/pool/pool-swap.ts`
- **Purpose**: Swaps tokens using a liquidity pool
- **Data Structure**:
  ```typescript
  interface PoolSwapData {
    poolId: string;             // Identifier of the liquidity pool to swap through
    trader: string;             // Account performing the swap
    tokenIn_symbol: string;     // Symbol of the token being sold
    tokenIn_issuer: string;     // Issuer of the token being sold
    tokenIn_amount: number;     // Amount of tokenIn to swap
    tokenOut_symbol: string;    // Symbol of the token being bought
    tokenOut_issuer: string;    // Issuer of the token being bought
    minTokenOut_amount?: number;// Optional: Minimum amount of tokenOut expected
  }
  ```

## 5. Token Transactions

#### Token Create
- **File**: `src/transactions/token/token-create.ts`
- **Purpose**: Creates a new fungible token
- **Data Structure**:
  ```typescript
  interface TokenCreateData {
    symbol: string;           // Symbol for the token
    name: string;             // Full name of the token
    precision: number;        // Decimal precision
    maxSupply: number;        // Maximum supply limit
    initialSupply?: number;   // Initial supply to mint to creator
    mintable?: boolean;       // Whether additional tokens can be minted
    burnable?: boolean;       // Whether tokens can be burned
    description?: string;     // Description of the token
    logoUrl?: string;         // URL to token logo
    websiteUrl?: string;      // URL to token website
  }
  ```

#### Token Mint
- **File**: `src/transactions/token/token-mint.ts`
- **Purpose**: Mints additional tokens (creator only)
- **Data Structure**:
  ```typescript
  interface TokenMintData {
    symbol: string;           // Symbol of the token to mint
    to: string;               // Account to receive the tokens
    amount: number;           // Amount to mint
  }
  ```

#### Token Transfer
- **File**: `src/transactions/token/token-transfer.ts`
- **Purpose**: Transfers tokens between accounts
- **Data Structure**:
  ```typescript
  interface TokenTransferData {
    symbol: string;           // Symbol of the token to transfer
    to: string;               // Recipient account
    amount: number;           // Amount to transfer
    memo?: string;            // Optional memo/note
  }
  ```

#### Token Update
- **File**: `src/transactions/token/token-update.ts`
- **Purpose**: Updates token metadata
- **Data Structure**:
  ```typescript
  interface TokenUpdateData {
    symbol: string;           // Symbol of the token to update
    name?: string;            // New name (optional)
    description?: string;     // New description (optional)
    logoUrl?: string;         // New logo URL (optional)
    websiteUrl?: string;      // New website URL (optional)
  }
  ```

## 6. Witness Transactions

#### Witness Register
- **File**: `src/transactions/witness/witness-register.ts`
- **Purpose**: Registers an account as a witness/validator
- **Data Structure**:
  ```typescript
  interface WitnessRegisterData {
    pub: string;              // Public key for witness operations
  }
  ```

#### Witness Vote
- **File**: `src/transactions/witness/witness-vote.ts`
- **Purpose**: Votes for a witness
- **Data Structure**:
  ```typescript
  interface WitnessVoteData {
    target: string;           // Witness account to vote for
  }
  ```

#### Witness Unvote
- **File**: `src/transactions/witness/witness-unvote.ts`
- **Purpose**: Removes a vote for a witness
- **Data Structure**:
  ```typescript
  interface WitnessUnvoteData {
    target: string;           // Witness account to unvote
  }
  ```

## Usage in Types and Parser

These transaction types should be reflected in:

1. The `TransactionType` enum in `src/transactions/types.ts`
2. The parser logic in `src/steemParser.ts`

### Suggested TransactionType Enum

```typescript
export enum TransactionType {
  // NFT Transactions
  NftCreateCollection = 'nft_create_collection',
  NftMint = 'nft_mint',
  NftTransfer = 'nft_transfer',
  NftListItem = 'nft_list_item',
  NftDelistItem = 'nft_delist_item',
  NftBuyItem = 'nft_buy_item',
  
  // Market Transactions
  MarketCreatePair = 'market_create_pair',
  MarketPlaceOrder = 'market_place_order',
  MarketCancelOrder = 'market_cancel_order',
  
  // Farm Transactions
  FarmCreate = 'farm_create',
  FarmStake = 'farm_stake',
  FarmUnstake = 'farm_unstake',
  FarmClaimRewards = 'farm_claim_rewards',
  
  // Pool Transactions
  PoolCreate = 'pool_create',
  PoolAddLiquidity = 'pool_add_liquidity',
  PoolRemoveLiquidity = 'pool_remove_liquidity',
  PoolSwap = 'pool_swap',
  
  // Token Transactions
  TokenCreate = 'token_create',
  TokenMint = 'token_mint',
  TokenTransfer = 'token_transfer',
  TokenUpdate = 'token_update',
  
  // Witness Transactions
  WitnessRegister = 'witness_register',
  WitnessVote = 'witness_vote',
  WitnessUnvote = 'witness_unvote'
}
``` 