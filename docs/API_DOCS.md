# API Documentation

## Overview

The Echelon API provides RESTful endpoints for interacting with the blockchain. All endpoints return JSON responses.

## Token Amount Formatting

### Formatted vs Raw Values

The API now returns token amounts in two formats:

1. **Formatted Amounts**: Human-readable values with proper decimal places (e.g., `"123.456"`)
2. **Raw Amounts**: Exact values in smallest units (e.g., `"123456000"`)

This approach provides both user-friendly display values and precise values for calculations.

### Example Response

```json
{
  "symbol": "ECH",
  "name": "Echelon Token",
  "maxSupply": "123.456",
  "rawMaxSupply": "123456000",
  "currentSupply": "50.000",
  "rawCurrentSupply": "50000000",
  "precision": 3
}
```

### Account Balances

Account balance responses include both formatted and raw values for each token:

```json
{
  "name": "alice",
  "balances": {
    "ECH": {
      "amount": "123.456",
      "rawAmount": "123456000"
    },
    "STEEM": {
      "amount": "1000.000",
      "rawAmount": "1000000000"
    }
  }
}
```

## Endpoints

### Tokens

#### GET /tokens
Returns a list of all registered tokens with formatted supply values.

**Response:**
```json
{
  "data": [
    {
      "symbol": "ECH",
      "name": "Echelon Token",
      "maxSupply": "1000000.000",
      "rawMaxSupply": "1000000000000",
      "currentSupply": "500000.000",
      "rawCurrentSupply": "500000000000",
      "precision": 3,
      "issuer": "echelon-issuer"
    }
  ],
  "total": 1,
  "limit": 10,
  "skip": 0
}
```

#### GET /tokens/:symbol
Returns details for a specific token.

**Response:**
```json
{
  "symbol": "ECH",
  "name": "Echelon Token",
  "maxSupply": "1000000.000",
  "rawMaxSupply": "1000000000000",
  "currentSupply": "500000.000",
  "rawCurrentSupply": "500000000000",
  "precision": 3,
  "issuer": "echelon-issuer",
  "description": "The native token of Echelon blockchain"
}
```

### Accounts

#### GET /accounts/:name
Returns account details with formatted token balances.

**Response:**
```json
{
  "success": true,
  "account": {
    "name": "alice",
    "balances": {
      "ECH": {
        "amount": "123.456",
        "rawAmount": "123456000"
      },
      "STEEM": {
        "amount": "1000.000",
        "rawAmount": "1000000000"
      }
    },
    "totalVoteWeight": "500000000000"
  }
}
```

#### GET /accounts/:name/tokens
Returns all tokens held by an account.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "symbol": "ECH",
      "amount": "123.456",
      "rawAmount": "123456000"
    },
    {
      "symbol": "STEEM",
      "amount": "1000.000",
      "rawAmount": "1000000000"
    }
  ]
}
```

### Pools

#### GET /pools
Returns a list of all liquidity pools with formatted token reserves.

**Response:**
```json
{
  "data": [
    {
      "id": "ECH_STEEM_300",
      "tokenA_symbol": "ECH",
      "tokenA_reserve": "1000.000",
      "rawTokenA_reserve": "1000000000",
      "tokenB_symbol": "STEEM",
      "tokenB_reserve": "500.000",
      "rawTokenB_reserve": "500000000",
      "totalLpTokens": "707106781",
      "feeTier": 300,
      "createdAt": "2025-01-18T12:00:00.000Z",
      "status": "ACTIVE"
    }
  ],
  "total": 1,
  "limit": 10,
  "skip": 0
}
```

#### GET /pools/route-swap
Returns the best swap route between two tokens.

**Query Parameters:**
- `fromTokenSymbol` (required): The input token symbol
- `toTokenSymbol` (required): The output token symbol  
- `amountIn` (required): The amount to swap (e.g., "1.23")

**Response:**
```json
{
  "bestRoute": {
    "hops": [
      {
        "poolId": "ECH_STEEM_300",
        "tokenIn": "ECH",
        "tokenOut": "STEEM",
        "amountIn": "100000000",
        "amountOut": "45000000",
        "amountInFormatted": "1.000",
        "amountOutFormatted": "0.450"
      }
    ],
    "finalAmountIn": "100000000",
    "finalAmountOut": "45000000",
    "finalAmountInFormatted": "1.000",
    "finalAmountOutFormatted": "0.450"
  },
  "allRoutes": [...]
}
```

#### POST /pools/autoSwapRoute
Executes an automatic swap using the best available route.

**Request Body:**
```json
{
  "tokenIn": "STEEM",
  "tokenOut": "ECH", 
  "amountIn": 1,
  "slippage": 0.5
}
```

**Parameters:**
- `tokenIn` (required): Input token symbol
- `tokenOut` (required): Output token symbol
- `amountIn` (required): Amount to swap (number or string)
- `slippage` (optional): Maximum slippage tolerance in percent (default: 0.5%)

**Response (Success):**
```json
{
  "success": true,
  "message": "Swap executed successfully",
  "transactionId": "auto_swap_1705600000000_abc123def",
  "route": {
    "hops": [
      {
        "poolId": "ECH_STEEM_300",
        "tokenIn": "STEEM",
        "tokenOut": "ECH",
        "amountIn": "1000000000",
        "amountOut": "2200000000",
        "amountInFormatted": "1.000",
        "amountOutFormatted": "2.200"
      }
    ],
    "finalAmountIn": "1000000000",
    "finalAmountOut": "2200000000",
    "finalAmountInFormatted": "1.000",
    "finalAmountOutFormatted": "2.200"
  },
  "executedAmountIn": "1.000",
  "executedAmountOut": "2.200"
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Swap execution failed",
  "route": {
    // Route information for debugging
  }
}
```

**Notes:**
- Currently supports single-hop routes only
- Multi-hop routes return a 501 Not Implemented error
- The trader is determined from authentication headers (currently uses placeholder)
- The swap is executed immediately when the request is processed
- Slippage protection prevents trades with excessive price movement

#### GET /pools/:poolId
Returns details for a specific liquidity pool.

**Response:**
```json
{
  "id": "ECH_STEEM_300",
  "tokenA_symbol": "ECH",
  "tokenA_reserve": "1000.000",
  "rawTokenA_reserve": "1000000000",
  "tokenB_symbol": "STEEM",
  "tokenB_reserve": "500.000",
  "rawTokenB_reserve": "500000000",
  "totalLpTokens": "707106781",
  "feeTier": 300,
  "createdAt": "2025-01-18T12:00:00.000Z",
  "status": "ACTIVE"
}
```

### Markets

#### GET /markets/pairs
Returns a list of all trading pairs with formatted prices and volumes.

**Response:**
```json
{
  "data": [
    {
      "id": "ECH-STEEM",
      "baseSymbol": "ECH",
      "quoteSymbol": "STEEM",
      "lastPrice": "0.500",
      "rawLastPrice": "500000000",
      "volume24h": "1000.000",
      "rawVolume24h": "1000000000",
      "high24h": "0.550",
      "rawHigh24h": "550000000",
      "low24h": "0.450",
      "rawLow24h": "450000000",
      "status": "ACTIVE"
    }
  ],
  "total": 1,
  "limit": 10,
  "skip": 0
}
```

#### GET /markets/orders/:orderId
Returns details for a specific order with formatted amounts.

**Response:**
```json
{
  "id": "order123",
  "pairId": "ECH-STEEM",
  "side": "buy",
  "type": "limit",
  "price": "0.500",
  "rawPrice": "500000000",
  "quantity": "100.000",
  "rawQuantity": "100000000",
  "filledQuantity": "50.000",
  "rawFilledQuantity": "50000000",
  "remainingQuantity": "50.000",
  "rawRemainingQuantity": "50000000",
  "status": "PARTIAL"
}
```

### Farms

#### GET /farms
Returns a list of all farming pools with formatted amounts.

**Response:**
```json
{
  "data": [
    {
      "id": "farm123",
      "stakingTokenSymbol": "LP_ECH_STEEM_300",
      "rewardTokenSymbol": "ECH",
      "totalStaked": "1000.000",
      "rawTotalStaked": "1000000000",
      "rewardRate": "10.000",
      "rawRewardRate": "10000000",
      "apr": "365000000",
      "totalRewardsAllocated": "5000.000",
      "rawTotalRewardsAllocated": "5000000000",
      "rewardsRemaining": "3000.000",
      "rawRewardsRemaining": "3000000000",
      "status": "ACTIVE"
    }
  ],
  "total": 1,
  "limit": 10,
  "skip": 0
}
```

### Launchpad

#### GET /launchpad
Returns a list of all launchpad projects with formatted amounts.

**Response:**
```json
{
  "data": [
    {
      "id": "launch123",
      "tokenSymbol": "NEWTOKEN",
      "tokenName": "New Token Project",
      "targetRaise": "10000.000",
      "rawTargetRaise": "10000000000",
      "totalCommitted": "5000.000",
      "rawTotalCommitted": "5000000000",
      "presale": {
        "goal": "10000.000",
        "rawGoal": "10000000000",
        "raisedAmount": "5000.000",
        "rawRaisedAmount": "5000000000",
        "tokenPrice": "0.001",
        "rawTokenPrice": "1000000",
        "participants": [
          {
            "userId": "alice",
            "amountContributed": "100.000",
            "rawAmountContributed": "100000000",
            "tokensAllocated": "100000.000",
            "rawTokensAllocated": "100000000000"
          }
        ]
      }
    }
  ]
}
```

### NFTs

#### GET /nfts/collections
Returns a list of all NFT collections with formatted amounts.

**Response:**
```json
{
  "data": [
    {
      "symbol": "COLLECTION",
      "name": "My NFT Collection",
      "maxSupply": "10000",
      "rawMaxSupply": "10000",
      "currentSupply": "5000",
      "rawCurrentSupply": "5000",
      "mintPrice": "1.000",
      "rawMintPrice": "1000000",
      "royaltyFeePercentage": "5000000"
    }
  ],
  "total": 1,
  "limit": 10,
  "skip": 0
}
```

#### GET /nfts/instances/:nftId
Returns details for a specific NFT with formatted sale/auction data.

**Response:**
```json
{
  "nftId": "COLLECTION-001",
  "collectionSymbol": "COLLECTION",
  "owner": "alice",
  "saleData": {
    "price": "10.000",
    "rawPrice": "10000000",
    "minBid": "5.000",
    "rawMinBid": "5000000",
    "buyNowPrice": "15.000",
    "rawBuyNowPrice": "15000000"
  }
}
```

### Events

#### GET /events
Returns a list of blockchain events with optional filtering and pagination.

**Query Parameters:**
- `type` (optional): Filter by event type (e.g., "pool_created", "pool_swap", "token_transfer")
- `actor` (optional): Filter by actor/participant (e.g., "alice", "bob")
- `transactionId` (optional): Filter by specific transaction ID
- `poolId` (optional): Filter by specific pool ID (e.g., "ECH_STEEM_300")
- `startTime` (optional): Filter events from this timestamp (ISO date string)
- `endTime` (optional): Filter events until this timestamp (ISO date string)
- `sortDirection` (optional): "asc" or "desc" (default: "desc")
- `limit` (optional): Number of events to return (default: 10)
- `offset` (optional): Number of events to skip (default: 0)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "event123",
      "type": "pool_created",
      "actor": "alice",
      "transactionId": "tx456",
      "timestamp": "2025-01-18T12:00:00.000Z",
      "data": {
        "poolId": "ECH_STEEM_300",
        "tokenA": "ECH",
        "tokenB": "STEEM",
        "feeTier": 300,
        "initialLiquidity": {
          "tokenAAmount": "1000.000",
          "rawTokenAAmount": "1000000000",
          "tokenBAmount": "500.000",
          "rawTokenBAmount": "500000000"
        }
      }
    },
    {
      "_id": "event124",
      "type": "pool_swap",
      "actor": "bob",
      "transactionId": "tx457",
      "timestamp": "2025-01-18T12:05:00.000Z",
      "data": {
        "poolId": "ECH_STEEM_300",
        "tokenIn": "ECH",
        "tokenOut": "STEEM",
        "amountIn": "100.000",
        "rawAmountIn": "100000000",
        "amountOut": "45.000",
        "rawAmountOut": "45000000",
        "fee": "0.300",
        "rawFee": "300000"
      }
    },
    {
      "_id": "event125",
      "type": "pool_liquidity_added",
      "actor": "charlie",
      "transactionId": "tx458",
      "timestamp": "2025-01-18T12:10:00.000Z",
      "data": {
        "poolId": "ECH_STEEM_300",
        "tokenAAmount": "200.000",
        "rawTokenAAmount": "200000000",
        "tokenBAmount": "100.000",
        "rawTokenBAmount": "100000000",
        "lpTokensMinted": "141421356",
        "rawLpTokensMinted": "141421356"
      }
    },
    {
      "_id": "event126",
      "type": "pool_liquidity_removed",
      "actor": "diana",
      "transactionId": "tx459",
      "timestamp": "2025-01-18T12:15:00.000Z",
      "data": {
        "poolId": "ECH_STEEM_300",
        "tokenAAmount": "50.000",
        "rawTokenAAmount": "50000000",
        "tokenBAmount": "25.000",
        "rawTokenBAmount": "25000000",
        "lpTokensBurned": "35355339",
        "rawLpTokensBurned": "35355339"
      }
    }
  ],
  "total": 4,
  "limit": 10,
  "skip": 0
}
```

#### GET /events/types
Returns a list of all available event types.

**Response:**
```json
{
  "success": true,
  "types": [
    "pool_created",
    "pool_swap",
    "pool_liquidity_added",
    "pool_liquidity_removed",
    "token_transfer",
    "token_mint",
    "token_burn",
    "market_order_placed",
    "market_order_filled",
    "market_order_cancelled",
    "farm_stake",
    "farm_unstake",
    "farm_rewards_claimed",
    "nft_mint",
    "nft_transfer",
    "nft_listed",
    "nft_sold",
    "launchpad_created",
    "launchpad_participation",
    "launchpad_tokens_claimed"
  ]
}
```

#### GET /events/:id
Returns details for a specific event.

**Response:**
```json
{
  "success": true,
  "event": {
    "_id": "event123",
    "type": "pool_swap",
    "actor": "alice",
    "transactionId": "tx456",
    "timestamp": "2025-01-18T12:00:00.000Z",
    "data": {
      "poolId": "ECH_STEEM_300",
      "tokenIn": "ECH",
      "tokenOut": "STEEM",
      "amountIn": "100.000",
      "rawAmountIn": "100000000",
      "amountOut": "45.000",
      "rawAmountOut": "45000000",
      "fee": "0.300",
      "rawFee": "300000",
      "priceImpact": "0.001",
      "slippage": "0.005"
    }
  }
}
```

**Example Usage:**

1. **Get all pool-related events:**
   ```
   GET /events?type=pool_created&type=pool_swap&type=pool_liquidity_added&type=pool_liquidity_removed
   ```

2. **Get events for a specific user:**
   ```
   GET /events?actor=alice&limit=20
   ```

3. **Get recent events with pagination:**
   ```
   GET /events?limit=50&offset=100&sortDirection=desc
   ```

4. **Get events within a time range:**
   ```
   GET /events?startTime=2025-01-18T00:00:00.000Z&endTime=2025-01-18T23:59:59.999Z
   ```

5. **Get events for a specific transaction:**
   ```
   GET /events?transactionId=tx456
   ```

6. **Get all events for a specific pool:**
   ```
   GET /events?poolId=ECH_STEEM_300
   ```

7. **Get pool events for a specific user:**
   ```
   GET /events?poolId=ECH_STEEM_300&actor=alice
   ```

8. **Get recent pool swaps only:**
   ```
   GET /events?poolId=ECH_STEEM_300&type=pool_swap&limit=20
   ```

## Error Responses

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Or for endpoints that don't use the success wrapper:

```json
{
  "message": "Error message description",
  "error": "Detailed error information"
}
``` 