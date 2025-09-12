# Meeray Blockchain Transaction Types

This document provides a comprehensive list of all transaction types implemented in the Meeray blockchain, including their data structures and purposes.

## Token Identifier System

**Important**: All tokens in the Echelon ecosystem use a simplified identifier format: `symbol`

**Examples**:
- Native tokens: `ECH`, `STEEM`, `SBD`
- Custom tokens: `MYTOKEN`, `GAMETOKEN`

**Security Benefits**:
- **Unique symbols**: Each token symbol is globally unique across the ecosystem
- **Simplified usage**: No need to track or specify issuers
- **Authorization control**: Only the token creator can perform certain operations on their tokens
- **Automatic verification**: System validates that transaction senders have proper permissions

**Usage in Transactions**:
- Market pairs: Specify both tokens by symbol only
- Trading: Reference tokens by their unique symbols
- Transfers: Simple symbol-based transfers

## 1. NFT Transactions

### NFT Create Collection (Type 1)
- **File**: `src/transactions/nft/nft-create-collection.ts`
- **Purpose**: Defines and registers a new collection of Non-Fungible Tokens (NFTs) on the blockchain.
- **Fees**: Requires paying `config.nftCollectionCreationFee` in `config.nativeTokenSymbol`. The fee is deducted from the sender during processing; insufficient balance causes validation failure.
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
- **Purpose**: Creates a new instance of an NFT within an existing collection.
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
- **Purpose**: Transfers ownership of a specific NFT instance from one account to another.
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
- **Purpose**: Lists a specific NFT instance for sale on the marketplace.
- **Data Structure**:
  ```typescript
  export interface NftListPayload {
    collectionSymbol: string;
    instanceId: string;
    price: number; // Sale price
    paymentTokenSymbol: string; // Token for payment (e.g., "ECH", "STEEM")
  }
  ```

### NFT Delist Item (Type 5)
- **File**: `src/transactions/nft/nft-delist-item.ts`
- **Purpose**: Removes a listed NFT instance from sale on the marketplace.
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
- **Purpose**: Executes the purchase of an NFT instance listed on the marketplace.
- **Data Structure**:
  ```typescript
  export interface NftBuyPayload {
    listingId: string; // The ID of the listing to buy
    // Payment token is implied by the listing
  }
  ```

### NftListing
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Represents an NFT currently listed for sale on the marketplace, detailing its price, seller, and status.
- **Data Structure**:
  ```typescript
  export interface NftListing {
    _id: string;
    collectionSymbol: string;
    instanceId: string;
    seller: string;
    price: number;
    paymentTokenSymbol: string;
    listedAt: string;
    status: 'ACTIVE' | 'SOLD' | 'CANCELLED';
  }
  ```

### NftListPayload
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Defines the data structure required to list an NFT for sale.
- **Data Structure**:
  ```typescript
  export interface NftListPayload {
    collectionSymbol: string;
    instanceId: string;
    price: number; // Sale price
    paymentTokenSymbol: string; // Token for payment (e.g., "ECH", "STEEM")
  }
  ```

### NftDelistPayload
- **File**: `src/transactions/nft/nft-market-interfaces.ts`
- **Purpose**: Defines the data structure required to remove an NFT from sale.
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
- **Purpose**: Defines the data structure required to purchase a listed NFT.
- **Data Structure**:
  ```typescript
  export interface NftBuyPayload {
    listingId: string; // The ID of the listing to buy
    // Payment token is implied by the listing
  }
  ```

### NFT Update Metadata (Type 7)
- **File**: `src/transactions/nft/nft-update.ts`
- **Purpose**: Updates the metadata (properties or URI) of an existing NFT instance.
- **Data Structure**:
  ```typescript
  export interface NftUpdateMetadataData {
    collectionSymbol: string;
    instanceId: string;
    properties?: Record<string, any>;
    uri?: string;
  }
  ```

### NFT Update Collection (Type 8)
- **File**: `src/transactions/nft/nft-update-collection.ts`
- **Purpose**: Updates the metadata or configuration of an existing NFT collection.
- **Data Structure**:
  ```typescript
  export interface NftUpdateCollectionData {
    symbol: string;
    name?: string;
    description?: string;
    logoUrl?: string;
    websiteUrl?: string;
    // Additional collection-level updates
  }
  ```

## 2. Market Transactions

**Important Security Note**: All market transactions use a simplified token identifier system where tokens are referenced by their unique `symbol` (e.g., `ECH`, `STEEM`). Each token symbol is globally unique across the ecosystem, eliminating the need to specify issuers.

**Token Identifier System**:
- All tokens: referenced by unique symbol only (e.g., `ECH`, `STEEM`, `MYTOKEN`)
- Format: `symbol` ensures unique token identification across the ecosystem

### Market Create Pair (Type 9)
- **File**: `src/transactions/market/market-create-pair.ts`
- **Purpose**: Establishes a new trading pair for assets on the decentralized exchange.
- **Data Structure**:
  ```typescript
  export interface MarketCreatePairData {
    baseAssetSymbol: string;      // Token symbol (e.g., "ECH")
    quoteAssetSymbol: string;     // Token symbol (e.g., "STEEM")
    metadata?: {                  // Optional metadata for the trading pair
      description?: string;
      category?: string;
      [key: string]: any;
    };
  }
  ```

### Market Cancel Order (Type 10)
- **File**: `src/transactions/market/market-cancel-order.ts`
- **Purpose**: Cancels a previously placed order that was created through the hybrid trading system.
- **Use Case**: When hybrid trades route through orderbook, they may create actual orders that users can cancel if unfilled.
- **Data Structure**:
  ```typescript
  export interface MarketCancelOrderData {
    orderId: string;          // Unique identifier of the order to cancel
    pairId: string;           // Trading pair ID for the order
  }
  ```

**Note**: Only orders created by the transaction sender can be cancelled for security reasons.

### Hybrid Market Trade (Type 11)
- **File**: `src/transactions/market/market-trade.ts`
- **Purpose**: Executes trades across both AMM pools and orderbook liquidity for optimal price discovery and execution.
- **Fees**: All trades incur a 0.3% fee regardless of routing:
  - **AMM Pools**: 0.3% fee taken from input amount, distributed to liquidity providers
  - **Orderbook**: 0.15% fee from buyer + 0.15% fee from seller = 0.3% total, distributed to corresponding AMM pool liquidity providers
- **Economic Model**: Orderbook fees support AMM liquidity growth, creating a unified ecosystem where all trading activity benefits liquidity providers
- **Note**: This is the primary and recommended trading method. Users can specify exact prices for limit orders or use slippage protection for market orders.
- **Data Structure**:
  ```typescript
  export interface MarketTradeData {
    tokenIn: string;                      // Token being sold (symbol only, e.g., "ECH")
    tokenOut: string;                     // Token being bought (symbol only, e.g., "STEEM")
    amountIn: string | bigint;           // Amount of tokenIn to trade
    
    // Price Control (choose ONE method):
    price?: string | bigint;             // LIMIT ORDER: Specific price to execute at
                                         // When specified, creates limit orders that wait for your price
    
    // Slippage Protection (for market orders - choose ONE method):
    maxSlippagePercent?: number;         // RECOMMENDED: Maximum allowed slippage (e.g., 2.0 for 2%)
    minAmountOut?: string | bigint;      // ADVANCED: Exact minimum output (requires token decimal knowledge)
  }
  ```

**Trading Modes**:

1. **LIMIT ORDERS** (specify `price`):
   - Your order will only execute when market reaches your specified price
   - Order stays in the orderbook until filled or manually cancelled
   - Perfect for waiting for favorable prices
   - Example: "I want to buy STEEM only if I can get it for 0.5 ECH or better"

2. **MARKET ORDERS** (specify slippage protection):
   - Executes immediately at current market prices
   - Uses automatic routing for best execution
   - Slippage protection prevents unfavorable execution

**Examples**:

**Limit Order Example**:
```json
{
  "type": 11,
  "sender": "alice",
  "data": {
    "tokenIn": "ECH",
    "tokenOut": "STEEM", 
    "amountIn": "100000000",
    "price": "50000000"     // Will only execute at 0.5 STEEM per ECH or better
  }
}
```

**Market Order Example**:
```json
{
  "type": 11,
  "sender": "alice",
  "data": {
    "tokenIn": "ECH",
    "tokenOut": "STEEM", 
    "amountIn": "100000000",
    "maxSlippagePercent": 2.0   // Execute immediately with max 2% slippage
  }
}
```

**Trading Process Explained**:

1. **Route Discovery**: The system automatically analyzes all available liquidity sources:
   - AMM pool liquidity (if pools exist for the token pair)
   - Orderbook liquidity (existing limit orders)
   - Multi-hop routes through intermediate tokens

2. **Optimal Execution**: The trade is split and routed to achieve:
   - Maximum output amount for the given input
   - Minimum price impact and slippage
   - Best overall execution quality

3. **Slippage Protection**: 
   - Set `maxSlippagePercent` for automatic protection (e.g., 2.0 = 2% max slippage)
   - Or set `minAmountOut` for precise minimum output control
   - Default slippage tolerance is 1% if not specified

4. **Atomic Execution**: The entire trade is atomic - if any part fails, the whole transaction reverts

**Example Trade**:
```json
{
  "type": 11,
  "sender": "alice",
  "data": {
    "tokenIn": "ECH",
    "tokenOut": "STEEM", 
    "amountIn": "100000000",
    "maxSlippagePercent": 2.0
  }
}
```

**Benefits over Traditional Orderbook Trading**:
- ✅ **No complex order management**: Just specify what you want to trade
- ✅ **Automatic best price discovery**: System finds optimal route across all liquidity
- ✅ **Reduced slippage**: Smart routing minimizes price impact
- ✅ **Simplified UX**: No need to analyze orderbooks or calculate prices manually
- ✅ **Better execution**: Combines AMM and orderbook advantages

## 8. How to Place Trades - Complete Guide

### Overview

The Echelon blockchain uses a **hybrid trading system** that combines the best of both AMM (Automated Market Maker) pools and traditional orderbook liquidity. This provides users with optimal price discovery and execution without the complexity of managing individual orders.

### Trading Methods

#### 1. Primary Method: Hybrid Trading (Type 10)

**What it is**: A single transaction that automatically routes your trade across all available liquidity sources for the best possible execution.

**How it works**:
1. You specify what token you want to sell and what you want to buy
2. The system analyzes all available liquidity:
   - AMM pools (Uniswap-style)
   - Orderbook liquidity (traditional exchange-style)
   - Multi-hop routes through intermediate tokens
3. Your trade is automatically split and routed for optimal execution
4. You get the best possible price with minimal slippage

**Example Transaction**:
```json
{
  "type": 11,
  "sender": "alice",
  "data": {
    "tokenIn": "ECH",
    "tokenOut": "STEEM",
    "amountIn": "100000000",
    "maxSlippagePercent": 2.0
  }
}
```

**Benefits**:
- ✅ Simple: Just specify input/output tokens and amounts
- ✅ Optimal pricing: Automatic best route discovery
- ✅ Low slippage: Smart routing minimizes price impact
- ✅ No order management: No need to monitor or cancel orders

### Trading Process Step-by-Step

#### Step 1: Determine Your Trade
- **Token In**: The token you want to sell (e.g., "ECH")
- **Token Out**: The token you want to buy (e.g., "STEEM")
- **Amount In**: How much of the input token to trade
- **Slippage Tolerance**: Maximum acceptable price deviation (typically 1-5%)

#### Step 2: Submit Hybrid Trade Transaction
```typescript
const tradeData = {
  tokenIn: "ECH",                  // Token being sold
  tokenOut: "STEEM",               // Token being bought
  amountIn: "100000000",           // 1.0 ECH (8 decimals)
  maxSlippagePercent: 2.0          // 2% maximum slippage
};

// Submit as custom_json transaction
await client.broadcast.sendOperations([
  ['custom_json', {
    required_auths: ['alice'],
    required_posting_auths: [],
    id: 'sidechain',
    json: JSON.stringify({
      contract: 'market_trade',
      payload: tradeData
    })
  }]
], privateKey);
```

#### Step 3: System Execution
The system automatically:
1. **Route Discovery**: Finds all possible trading paths
2. **Optimization**: Calculates the best combination of routes
3. **Execution**: Atomically executes the trade across multiple liquidity sources
4. **Settlement**: Updates balances and provides execution summary

### Slippage Protection

**What is slippage?**
Slippage occurs when the actual execution price differs from the expected price due to market movement or insufficient liquidity.

**Protection Methods**:

1. **Percentage-based** (Recommended):
   ```json
   {
     "maxSlippagePercent": 2.0  // 2% maximum slippage
   }
   ```

2. **Absolute minimum output**:
   ```json
   {
     "minAmountOut": "95000000"  // Minimum tokens to receive
   }
   ```

**Common Slippage Settings**:
- **0.1-0.5%**: For stable/highly liquid pairs
- **1-2%**: For most trading pairs (recommended default)
- **3-5%**: For volatile or low-liquidity pairs
- **>5%**: Only for very illiquid pairs or urgent trades

### Token Identifier Format

All tokens use the format: `symbol`

**Examples**:
- Native tokens: `ECH`, `STEEM`, `SBD`
- Custom tokens: `MYTOKEN`, `GAMETOKEN`

**Security Note**: Each token symbol is globally unique across the ecosystem, ensuring you're always trading the correct token.

### Advanced Features

#### Order Cancellation (Type 9)
If hybrid trading creates orderbook orders that don't fill immediately, you can cancel them:

```json
{
  "type": 10,
  "sender": "alice", 
  "data": {
    "orderId": "order_12345"
  }
}
```

#### Creating Trading Pairs (Type 7)
Before trading, someone must create the trading pair:

```json
{
  "type": 9,
  "sender": "alice",
  "data": {
    "baseAssetSymbol": "ECH",
    "quoteAssetSymbol": "STEEM",
    "metadata": {
      "description": "ECH/STEEM trading pair"
    }
  }
}
```

### Best Practices

1. **Start with small amounts** to test trading
2. **Use appropriate slippage** based on pair liquidity
3. **Check token identifiers** to ensure correct assets
4. **Monitor execution** for unexpected results
5. **Understand that all trades are final** - no refunds for user errors

### Common Trading Scenarios

#### Scenario 1: Basic Token Swap
**Goal**: Swap 1 ECH for STEEM
```json
{
  "tokenIn": "ECH",
  "tokenOut": "STEEM", 
  "amountIn": "100000000",
  "maxSlippagePercent": 1.0
}
```

#### Scenario 2: Large Trade with Higher Slippage
**Goal**: Swap 100 ECH, accept up to 3% slippage
```json
{
  "tokenIn": "ECH",
  "tokenOut": "STEEM",
  "amountIn": "10000000000", 
  "maxSlippagePercent": 3.0
}
```

#### Scenario 3: Precise Output Control
**Goal**: Ensure receiving at least 0.95 STEEM
```json
{
  "tokenIn": "ECH",
  "tokenOut": "STEEM",
  "amountIn": "100000000",
  "minAmountOut": "950"
}
```

### Error Handling

**Common Errors**:
- `"Insufficient balance"`: Not enough input tokens
- `"Output amount less than minimum"`: Slippage exceeded
- `"No route found"`: No liquidity path exists
- `"Invalid token identifier"`: Malformed token format

**Solutions**:
- Check balances before trading
- Increase slippage tolerance
- Ensure trading pairs exist
- Verify token identifier format

### Migration from Old System

**⚠️ Important**: The old orderbook-only system (market_place_order) has been deprecated and replaced with hybrid trading.

**Old Way** (Deprecated):
```json
{
  "type": 8,  // No longer supported
  "data": {
    "pairId": "ECH-STEEM",
    "type": "LIMIT",
    "side": "BUY", 
    "price": "1000000",
    "quantity": "100000000"
  }
}
```

**New Way** (Current):
```json
{
  "type": 11,
  "data": {
    "tokenIn": "STEEM",
    "tokenOut": "ECH",
    "amountIn": "1000",
    "maxSlippagePercent": 2.0
  }
}
```

**Benefits of Migration**:
- ✅ Simpler: No complex order parameters
- ✅ Better execution: Automatic optimal routing
- ✅ Less risk: No order management needed
- ✅ Better UX: Just specify what you want to trade

## 9. Supporting Market Interfaces

### TradingPair
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents a tradable asset pair on the market, including its symbols and trading parameters.
- **Data Structure**:
  ```typescript
  export interface TradingPairData {
    _id: string;                          // Unique pair identifier (e.g., ECH-STEEM)
    baseAssetSymbol: string;              // Base asset symbol (e.g., ECH)
    quoteAssetSymbol: string;             // Quote asset symbol (e.g., STEEM)
    tickSize: string | bigint;            // Minimum price movement
    lotSize: string | bigint;             // Minimum quantity movement
    minNotional: string | bigint;         // Minimum order value in quote asset
    minTradeAmount: string | bigint;      // Minimum trade amount
    maxTradeAmount: string | bigint;      // Maximum trade amount
    status: string;                       // Pair status (TRADING, PRE_TRADE, HALTED)
    createdAt: string;                    // ISO date string
    lastUpdatedAt?: string;               // ISO date string
  }
  ```

### Order
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents a buy or sell order placed on the exchange, detailing its parameters, status, and fill information.
- **Data Structure**:
  ```typescript
  export interface OrderData {
    _id: string;                          // Unique order ID
    userId: string;                       // Account ID of the user
    pairId: string;                       // Reference to TradingPair._id
    baseAssetSymbol: string;              // Base asset symbol
    quoteAssetSymbol: string;             // Quote asset symbol
    type: OrderType;                      // LIMIT or MARKET
    side: OrderSide;                      // BUY or SELL
    status: OrderStatus;                  // OPEN, FILLED, CANCELLED, etc.
    price?: string | bigint;              // Price for LIMIT orders
    quantity: string | bigint;            // Desired amount of base asset
    filledQuantity: string | bigint;      // Amount filled
    averageFillPrice?: string | bigint;   // Average fill price
    cumulativeQuoteValue?: string | bigint; // Total value in quote asset
    quoteOrderQty?: string | bigint;      // For MARKET orders
    createdAt: string;                    // ISO Date string
    updatedAt: string;                    // ISO Date string
    timeInForce?: 'GTC' | 'IOC' | 'FOK';  // Time in force
    expiresAt?: string;                   // ISO Date string
  }
  ```

### HybridRoute
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Defines routing information for hybrid trades across AMM and orderbook liquidity.
- **Data Structure**:
  ```typescript
  export interface HybridRoute {
    type: 'AMM' | 'ORDERBOOK';           // Liquidity source type
    allocation: number;                   // Percentage of trade (0-100)
    details: AMMRouteDetails | OrderbookRouteDetails;
  }

  export interface AMMRouteDetails {
    poolId?: string;                     // For single pool swap
    hops?: Array<{                       // For multi-hop AMM swaps
      poolId: string;
      tokenIn: string;
      tokenOut: string;
    }>;
  }

  export interface OrderbookRouteDetails {
    pairId: string;                      // Trading pair ID
    side: OrderSide;                     // BUY or SELL
    orderType?: OrderType;               // LIMIT or MARKET
    price?: string | bigint;             // For LIMIT orders
  }
  ```

### Trade
- **File**: `src/transactions/market/market-interfaces.ts`
- **Purpose**: Represents an executed trade between a buyer and a seller on the exchange for a specific pair.
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
- **Purpose**: Represents a single price level in an order book, showing aggregated quantity and order count.
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
- **Purpose**: Provides a snapshot of the current order book (bids and asks) for a specific trading pair.
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

### Farm Create (Type 12)
- **File**: `src/transactions/farm/farm-create.ts`
- **Purpose**: Establishes a new yield farm, allowing users to stake LP tokens for rewards.
- **Data Structure**:
  ```typescript
  export interface FarmCreateData {
    stakingTokenSymbol: string;    // Symbol of the token that will be staked (e.g., "ECH_STEEM_LP")
    rewardTokenSymbol: string;     // Symbol of the token given as reward
    // farmId will be generated based on staking and reward tokens
  }
  ```

### Farm Stake (Type 13)
- **File**: `src/transactions/farm/farm-stake.ts`
- **Purpose**: Allows a user to stake their tokens into a specified farm to earn rewards.
- **Data Structure**:
  ```typescript
  export interface FarmStakeData {
    farmId: string;             // Identifier of the farm
    tokenAmount: number;        // Amount of tokens to stake
  }
  ```

### Farm Unstake (Type 14)
- **File**: `src/transactions/farm/farm-unstake.ts`
- **Purpose**: Allows a user to withdraw their staked tokens from a farm.
- **Data Structure**:
  ```typescript
  export interface FarmUnstakeData {
    farmId: string;             // Identifier of the farm
    tokenAmount: number;        // Amount of tokens to unstake
  }
  ```

### Farm Claim Rewards (Type 15)
- **File**: `src/transactions/farm/farm-claim-rewards.ts`
- **Purpose**: Allows a user to claim the accumulated rewards earned from staking in a farm.
- **Data Structure**:
  ```typescript
  export interface FarmClaimRewardsData {
    farmId: string;             // Identifier of the farm
  }
  ```

## 4. Pool Transactions

### Pool Create (Type 16)
- **File**: `src/transactions/pool/pool-create.ts`
- **Purpose**: Creates a new liquidity pool for a pair of tokens, enabling swaps and liquidity provision.
- **Data Structure**:
  ```typescript
  export interface PoolCreateData {
    tokenA_symbol: string;      // Symbol of the first token in the pair
    tokenB_symbol: string;      // Symbol of the second token in the pair
    // Note: Fee is fixed at 0.3% (300 basis points) - no longer configurable
  }
  ```

### Pool Add Liquidity (Type 17)
- **File**: `src/transactions/pool/pool-add-liquidity.ts`
- **Purpose**: Allows a user to add liquidity to an existing pool by depositing a pair of tokens.
- **Data Structure**:
  ```typescript
  export interface PoolAddLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    tokenA_amount: number;      // Amount of token A to add
    tokenB_amount: number;      // Amount of token B to add (must respect pool ratio, or be first provider)
  }
  ```

### Pool Remove Liquidity (Type 18)
- **File**: `src/transactions/pool/pool-remove-liquidity.ts`
- **Purpose**: Allows a user to remove their provided liquidity from a pool by burning LP tokens.
- **Data Structure**:
  ```typescript
  export interface PoolRemoveLiquidityData {
    poolId: string;             // Identifier of the liquidity pool
    lpTokenAmount: number;      // Amount of LP (Liquidity Provider) tokens to burn/redeem
  }
  ```

### Pool Swap (Type 19)
- **File**: `src/transactions/pool/pool-swap.ts`
- **Purpose**: Allows a user to swap one token for another through liquidity pools. This transaction supports three modes:
  1. **Single-hop swap**: Direct swap through a specific pool
  2. **Multi-hop routed swap**: Execute a predefined route through multiple pools
  3. **Auto-route swap**: Automatically find and execute the best route

**Data Structure**:
```typescript
export interface PoolSwapData {
  // For single-hop swaps (backward compatible)
  poolId?: string;             // Identifier of the liquidity pool to swap through (for direct swap)
  tokenIn_symbol: string;     // Symbol of the token being swapped in
  tokenOut_symbol: string;    // Symbol of the token being swapped out
  amountIn: string;           // Amount of input token to swap (as string to preserve precision)
  minAmountOut: string;       // Minimum amount of output token expected (as string, for slippage protection)

  // For multi-hop routing (new functionality)
  fromTokenSymbol?: string;   // Overall input token symbol for a routed swap
  toTokenSymbol?: string;     // Overall output token symbol for a routed swap
  hops?: Array<{
    poolId: string;
    tokenIn_symbol: string;
    tokenOut_symbol: string;
    amountIn: string;
    minAmountOut: string;
  }>;
}
```

**Example 1: Single-Hop Swap** (Backward Compatible):
```json
{
  "type": 17,
  "sender": "alice",
  "data": {
    "poolId": "ECH_STEEM",
    "tokenIn_symbol": "ECH",
    "tokenOut_symbol": "STEEM",
    "amountIn": "100000000",
    "minAmountOut": "44775000"
  }
}
```

**Example 2: Multi-Hop Routed Swap**:
```json
{
  "type": 17,
  "sender": "alice",
  "data": {
    "tokenIn_symbol": "ECH",
    "tokenOut_symbol": "USDT",
    "amountIn": "100000000",
    "minAmountOut": "44000000",
    "hops": [
      {
        "poolId": "ECH_STEEM",
        "tokenIn_symbol": "ECH",
        "tokenOut_symbol": "STEEM",
        "amountIn": "100000000",
        "minAmountOut": "44775000"
      },
      {
        "poolId": "STEEM_USDT",
        "tokenIn_symbol": "STEEM",
        "tokenOut_symbol": "USDT",
        "amountIn": "44775000",
        "minAmountOut": "44000000"
      }
    ]
  }
}
```

**Example 3: Auto-Route Swap** (Simplest):
```json
{
  "type": 17,
  "sender": "alice",
  "data": {
    "fromTokenSymbol": "ECH",
    "toTokenSymbol": "USDT",
    "amountIn": "100000000",
    "minAmountOut": "44000000",
    "slippagePercent": 2.0  // Optional: 2% slippage tolerance
  }
}
```

**Example Using Route-Swap API Data**:
To execute a swap using data from the `/pools/route-swap` API:

1. **Get route information**:
```bash
POST /pools/route-swap
{
  "fromTokenSymbol": "ECH",
  "toTokenSymbol": "USDT", 
  "amountIn": 1,
  "slippage": 0.5
}
```

2. **API Response**:
```json
{
  "bestRoute": {
    "hops": [
      {
        "poolId": "ECH_STEEM",
        "tokenIn": "ECH",
        "tokenOut": "STEEM",
        "amountIn": "100000000",
        "amountOut": "45000000",
        "amountInFormatted": "1.000",
        "amountOutFormatted": "0.450",
        "minAmountOut": "44775000",
        "minAmountOutFormatted": "0.448",
        "slippagePercent": 0.5,
        "priceImpact": 0.1234,
        "priceImpactFormatted": "0.1234%"
      },
      {
        "poolId": "STEEM_USDT",
        "tokenIn": "STEEM",
        "tokenOut": "USDT",
        "amountIn": "45000000",
        "amountOut": "44500000",
        "amountInFormatted": "0.450",
        "amountOutFormatted": "44.500",
        "minAmountOut": "44275000",
        "minAmountOutFormatted": "44.275",
        "slippagePercent": 0.5,
        "priceImpact": 0.2345,
        "priceImpactFormatted": "0.2345%"
      }
    ],
    "finalAmountIn": "100000000",
    "finalAmountOut": "44500000",
    "finalAmountInFormatted": "1.000",
    "finalAmountOutFormatted": "44.500",
    "minFinalAmountOut": "44275000",
    "minFinalAmountOutFormatted": "44.275",
    "slippagePercent": 0.5,
    "totalPriceImpact": 0.3579,
    "totalPriceImpactFormatted": "0.3579%"
  }
}
```

3. **Execute multi-hop swap transaction**:
```json
{
  "type": 17,
  "sender": "alice",
  "data": {
    "tokenIn_symbol": "ECH",
    "tokenOut_symbol": "USDT",
    "amountIn": "100000000",
    "minAmountOut": "44275000",
    "hops": [
      {
        "poolId": "ECH_STEEM",
        "tokenIn_symbol": "ECH",
        "tokenOut_symbol": "STEEM",
        "amountIn": "100000000",
        "minAmountOut": "44775000"
      },
      {
        "poolId": "STEEM_USDT",
        "tokenIn_symbol": "STEEM",
        "tokenOut_symbol": "USDT",
        "amountIn": "45000000",
        "minAmountOut": "44275000"
      }
    ]
  }
}
```

**Notes**:
- **Single-hop swaps**: Use `poolId` for direct swaps through one pool (backward compatible)
- **Multi-hop routed swaps**: Use `hops` array to specify the exact route and amounts for each hop
- **Auto-route swaps**: Use `fromTokenSymbol` and `toTokenSymbol` to let the system find the best route automatically
- All modes support slippage protection via `minAmountOut`
- Raw amounts (without formatting) should be used in the transaction data
- The transaction is atomic - if any hop fails, the entire swap is rolled back
- For auto-route swaps, the system will find the route with the highest output amount

**Slippage Protection**:
- **Default slippage**: 1% for auto-route swaps if not specified
- **Custom slippage**: Use `slippagePercent` parameter (e.g., 2.0 for 2%)
- **Manual control**: Set `minAmountOut` explicitly for precise control
- **Common issues**: If you see "Output amount is less than minimum required", increase slippage tolerance or lower `minAmountOut`

## 5. Token Transactions

### Token Create (Type 20)
- **File**: `src/transactions/token/token-create.ts`
- **Purpose**: Registers a new fungible token on the blockchain with specified properties.
- **Fees**: Requires paying `config.tokenCreationFee` in `config.nativeTokenSymbol`. The fee is deducted from the sender during processing; insufficient balance causes validation failure.
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

### Token Mint (Type 21)
- **File**: `src/transactions/token/token-mint.ts`
- **Purpose**: Creates new units of an existing mintable fungible token and assigns them to an account.
- **Data Structure**:
  ```typescript
  export interface TokenMintData {
    symbol: string;
    to: string;
    amount: number;
  }
  ```

### Token Transfer (Type 22)
- **File**: `src/transactions/token/token-transfer.ts`
- **Purpose**: Transfers a specified amount of a fungible token from one account to another.
- **Data Structure**:
  ```typescript
  export interface TokenTransferData {
    symbol: string;
    to: string;
    amount: number;
    memo?: string;
  }
  ```

### Token Update (Type 23)
- **File**: `src/transactions/token/token-update.ts`
- **Purpose**: Modifies the metadata (e.g., name, description, URLs) of an existing fungible token.
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

### Witness Register (Type 24)
- **File**: `src/transactions/witness/witness-register.ts`
- **Purpose**: Allows an account to register as a block-producing witness candidate.
- **Data Structure**:
  ```typescript
  export interface WitnessRegisterData {
    pub: string;
  }
  ```

### Witness Vote (Type 25)
- **File**: `src/transactions/witness/witness-vote.ts`
- **Purpose**: Allows an account to cast a vote for a registered witness candidate.
- **Data Structure**:
  ```typescript
  export interface WitnessVoteData {
    target: string;
  }
  ```

### Witness Unvote (Type 26)
- **File**: `src/transactions/witness/witness-unvote.ts`
- **Purpose**: Allows an account to retract a previously cast vote for a witness candidate.
- **Data Structure**:
  ```typescript
  export interface WitnessUnvoteData {
    target: string;
  }
  ```

## 7. Launchpad Transactions

### Launchpad Launch Token (Type 27)
- **File**: `src/transactions/launchpad/launchpad-launch-token.ts`
- **Purpose**: Initiates a new token launch project on the launchpad, defining its tokenomics, presale, and liquidity details.
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
  }
  ```

### Launchpad Participate Presale (Type 28)
- **File**: `src/transactions/launchpad/launchpad-participate-presale.ts`
- **Purpose**: Allows a user to contribute funds to participate in the presale of a launchpad project.
- **Data Structure**:
  ```typescript
  export interface LaunchpadParticipatePresaleData {
    userId: string;
    launchpadId: string;
    contributionAmount: number;
  }
  ```

### Launchpad Claim Tokens (Type 29)
- **File**: `src/transactions/launchpad/launchpad-claim-tokens.ts`
- **Purpose**: Allows a user to claim their allocated tokens from a launchpad project after presale or vesting.
- **Data Structure**:
  ```typescript
  export interface LaunchpadClaimTokensData {
    userId: string;
    launchpadId: string;
    allocationType: TokenDistributionRecipient; // From launchpad-interfaces.ts
  }
  ```

## 10. Other Core Interfaces

### VestingSchedule
- **File**: `src/transactions/launchpad/launchpad-interfaces.ts`
- **Purpose**: Defines the rules and timeline for releasing tokens over a period (vesting) for launchpad projects.
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
- **Purpose**: Describes how tokens within a launchpad project are distributed among different stakeholders (e.g., team, investors) including vesting.
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
- **Purpose**: Outlines the economic model of a token, including total supply, distribution, and allocation details for launchpad projects.
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
- **Purpose**: Contains all parameters and conditions for a token presale event within a launchpad project.
- **Data Structure**:
  ```typescript
  interface PresaleDetails {
    presaleTokenAllocationPercentage: number;
    pricePerToken: number;
    quoteAssetForPresaleSymbol: string;
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
- **Purpose**: Specifies the details for providing initial liquidity to a decentralized exchange for a token launched via the launchpad.
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
- **Purpose**: Represents a token specifically created or managed within the context of the launchpad system.
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
- **Purpose**: Represents a single project on the token launchpad platform, tracking its status, details, and progress.
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
- **Purpose**: Represents a pool of two token assets, facilitating decentralized trading and earning fees for liquidity providers.
- **Data Structure**:
  ```typescript
  export interface LiquidityPool {
    _id: string;
    tokenA_symbol: string;
    tokenA_reserve: number;
    tokenB_symbol: string;
    tokenB_reserve: number;
    totalLpTokens: number;
    lpTokenSymbol: string;
    feeRate: number;
    createdAt: string;
    lastUpdatedAt?: string;
  }
  ```

### uidityPosition
- **File**: `src/transactions/pool/pool-interfaces.ts`
- **Purpose**: Represents a user's share and balance of LP tokens in a specific liquidity pool.
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
- **Purpose**: Represents a yield farming contract where users can stake tokens to earn reward tokens.
- **Data Structure**:
  ```typescript
  export interface Farm {
    _id: string;
    stakingTokenSymbol: string;
    rewardTokenSymbol: string;
    totalTokensStaked: number;
    createdAt: string;
  }
  ```