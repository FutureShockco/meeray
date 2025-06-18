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