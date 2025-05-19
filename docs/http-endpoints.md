# Echelon Blockchain HTTP API Documentation

This document provides a comprehensive guide to all HTTP API endpoints available in the Echelon blockchain.

## Base URL

All endpoints are relative to the base URL of the API server. By default, the API server runs on port 3001.

```
http://localhost:3001
```

## Endpoint Categories

- [Accounts](#accounts)
- [Blocks](#blocks)
- [Farms](#farms)
- [Markets](#markets)
- [Mining](#mining)
- [NFTs](#nfts)
- [Pools](#pools)
- [Tokens](#tokens)
- [Witnesses](#witnesses)

## Accounts

### GET /accounts

Lists accounts with pagination and filtering options.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `hasToken` (optional) - Filter accounts that hold a specific token (token symbol)
- `isWitness` (optional) - Filter for witness accounts (true/false)
- `sortBy` (optional) - Field to sort by (default: 'name')
- `sortDirection` (optional) - Sort direction ('asc' or 'desc', default: 'asc')

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "name": "string",
      "balances": {},
      "tokens": {},
      "votedWitnesses": [],
      "totalVoteWeight": 0
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /accounts/:name

Retrieves details for a specific account.

**Parameters:**
- `name` (path parameter) - The name of the account to retrieve

**Response:**
```json
{
  "success": true,
  "account": {
    "_id": "string",
    "name": "string",
    "balances": {},
    "tokens": {},
    "votedWitnesses": [],
    "totalVoteWeight": 0
  }
}
```

### GET /accounts/:name/transactions

Retrieves transactions involving a specific account.

**Parameters:**
- `name` (path parameter) - The name of the account to retrieve transactions for

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `type` (optional) - Filter by transaction type (numeric value)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "type": 0,
      "data": {},
      "sender": "string",
      "ts": 0,
      "ref": "string",
      "hash": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /accounts/:name/tokens

Retrieves token balances for a specific account.

**Parameters:**
- `name` (path parameter) - The name of the account to retrieve token balances for

**Response:**
```json
{
  "success": true,
  "account": "string",
  "tokens": [
    {
      "symbol": "string",
      "amount": 0
    }
  ]
}
```

## Blocks

### GET /blocks

Lists blocks with pagination and filtering options.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `hasTransactionType` (optional) - Filter blocks containing a specific transaction type
- `minTimestamp` (optional) - Filter blocks after a specific timestamp
- `maxTimestamp` (optional) - Filter blocks before a specific timestamp
- `sortDirection` (optional) - Sort direction ('asc' for oldest first, 'desc' for newest first, default: 'desc')

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "hash": "string",
      "timestamp": 0,
      "transactions": [],
      "height": 0
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /blocks/latest

Retrieves the latest block information.

**Response:**
```json
{
  "success": true,
  "block": {
    "hash": "string",
    "timestamp": 0,
    "transactions": [],
    "height": 0
  }
}
```

### GET /blocks/height/:height

Retrieves a block by its height.

**Parameters:**
- `height` (path parameter) - The height of the block to retrieve

**Response:**
```json
{
  "success": true,
  "block": {
    "hash": "string",
    "timestamp": 0,
    "transactions": [],
    "height": 0
  }
}
```

### GET /blocks/hash/:hash

Retrieves a block by its hash.

**Parameters:**
- `hash` (path parameter) - The hash of the block to retrieve

**Response:**
```json
{
  "success": true,
  "block": {
    "hash": "string",
    "timestamp": 0,
    "transactions": [],
    "height": 0
  }
}
```

### GET /blocks/:height/transactions

Retrieves all transactions in a specific block.

**Parameters:**
- `height` (path parameter) - The height of the block to retrieve transactions from

**Response:**
```json
{
  "success": true,
  "blockHeight": 0,
  "transactions": [
    {
      "type": 0,
      "data": {},
      "sender": "string",
      "ts": 0,
      "ref": "string",
      "hash": "string"
    }
  ]
}
```

## Farms

### GET /farms

Lists all farms with pagination.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `status` (optional) - Filter by farm status
- `rewardTokenSymbol` (optional) - Filter by reward token symbol

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "lpTokenSymbol": "string",
      "lpTokenIssuer": "string",
      "rewardTokenSymbol": "string",
      "rewardTokenIssuer": "string",
      "totalLpStaked": 0,
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /farms/:farmId

Retrieves details for a specific farm.

**Parameters:**
- `farmId` (path parameter) - The ID of the farm to retrieve

**Response:**
```json
{
  "_id": "string",
  "lpTokenSymbol": "string",
  "lpTokenIssuer": "string",
  "rewardTokenSymbol": "string",
  "rewardTokenIssuer": "string",
  "totalLpStaked": 0,
  "createdAt": "string"
}
```

### GET /farms/positions/user/:userId

Lists all farm positions for a specific user with pagination.

**Parameters:**
- `userId` (path parameter) - The ID of the user whose positions to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "staker": "string",
      "farmId": "string",
      "stakedLpAmount": 0,
      "createdAt": "string",
      "lastStakedAt": "string",
      "lastClaimedAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /farms/positions/farm/:farmId

Lists all user positions for a specific farm with pagination.

**Parameters:**
- `farmId` (path parameter) - The ID of the farm whose positions to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "staker": "string",
      "farmId": "string",
      "stakedLpAmount": 0,
      "createdAt": "string",
      "lastStakedAt": "string",
      "lastClaimedAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /farms/positions/:positionId

Retrieves details for a specific farm position.

**Parameters:**
- `positionId` (path parameter) - The ID of the farm position to retrieve

**Response:**
```json
{
  "_id": "string",
  "staker": "string",
  "farmId": "string",
  "stakedLpAmount": 0,
  "createdAt": "string",
  "lastStakedAt": "string",
  "lastClaimedAt": "string"
}
```

### GET /farms/positions/user/:userId/farm/:farmId

Retrieves a specific user's position in a specific farm.

**Parameters:**
- `userId` (path parameter) - The ID of the user
- `farmId` (path parameter) - The ID of the farm

**Response:**
```json
{
  "_id": "string",
  "staker": "string",
  "farmId": "string",
  "stakedLpAmount": 0,
  "createdAt": "string",
  "lastStakedAt": "string",
  "lastClaimedAt": "string"
}
```

## Markets

### GET /markets/pairs

Lists all trading pairs with pagination.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `status` (optional) - Filter by pair status

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "baseAssetSymbol": "string",
      "baseAssetIssuer": "string",
      "quoteAssetSymbol": "string",
      "quoteAssetIssuer": "string",
      "status": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /markets/pairs/:pairId

Retrieves details for a specific trading pair.

**Parameters:**
- `pairId` (path parameter) - The ID of the pair to retrieve

**Response:**
```json
{
  "_id": "string",
  "baseAssetSymbol": "string",
  "baseAssetIssuer": "string",
  "quoteAssetSymbol": "string",
  "quoteAssetIssuer": "string",
  "status": "string"
}
```

### GET /markets/orders/pair/:pairId

Lists all orders for a specific trading pair with pagination.

**Parameters:**
- `pairId` (path parameter) - The ID of the pair whose orders to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `status` (optional) - Filter by order status
- `side` (optional) - Filter by order side
- `userId` (optional) - Filter by user ID

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "userId": "string",
      "pairId": "string",
      "type": "string",
      "side": "string",
      "price": 0,
      "quantity": 0,
      "status": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /markets/orders/user/:userId

Lists all orders for a specific user with pagination.

**Parameters:**
- `userId` (path parameter) - The ID of the user whose orders to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `pairId` (optional) - Filter by pair ID
- `status` (optional) - Filter by order status
- `side` (optional) - Filter by order side

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "userId": "string",
      "pairId": "string",
      "type": "string",
      "side": "string",
      "price": 0,
      "quantity": 0,
      "status": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /markets/orders/:orderId

Retrieves details for a specific order.

**Parameters:**
- `orderId` (path parameter) - The ID of the order to retrieve

**Response:**
```json
{
  "_id": "string",
  "userId": "string",
  "pairId": "string",
  "type": "string",
  "side": "string",
  "price": 0,
  "quantity": 0,
  "status": "string",
  "createdAt": "string"
}
```

### GET /markets/trades/pair/:pairId

Lists all trades for a specific trading pair with pagination.

**Parameters:**
- `pairId` (path parameter) - The ID of the pair whose trades to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `fromTimestamp` (optional) - Filter by minimum timestamp
- `toTimestamp` (optional) - Filter by maximum timestamp

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "pairId": "string",
      "makerOrderId": "string",
      "takerOrderId": "string",
      "price": 0,
      "quantity": 0,
      "timestamp": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /markets/trades/order/:orderId

Lists all trades involving a specific order (as maker or taker).

**Parameters:**
- `orderId` (path parameter) - The ID of the order whose trades to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "pairId": "string",
      "makerOrderId": "string",
      "takerOrderId": "string",
      "price": 0,
      "quantity": 0,
      "timestamp": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /markets/trades/:tradeId

Retrieves details for a specific trade.

**Parameters:**
- `tradeId` (path parameter) - The ID of the trade to retrieve

**Response:**
```json
{
  "_id": "string",
  "pairId": "string",
  "makerOrderId": "string",
  "takerOrderId": "string",
  "price": 0,
  "quantity": 0,
  "timestamp": "string"
}
```

## Mining

### GET /mine

Triggers the mining of a new block.

**Response:**
```json
{
  "success": true,
  "block": {
    "hash": "string",
    "timestamp": "string",
    "transactions": [],
    "height": 0
  }
}
```

## NFTs

### GET /nfts/collections

Lists all NFT collections with pagination and filtering.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `creator` (optional) - Filter by creator account name
- `allowDelegation` (optional) - Filter by delegation status (true/false)
- `createdAfter` (optional) - Filter collections created after a specific date
- `createdBefore` (optional) - Filter collections created before a specific date
- `nameSearch` (optional) - Search within collection names (case insensitive partial match)
- `sortBy` (optional) - Field to sort by (default: 'createdAt')
- `sortDirection` (optional) - Sort direction ('asc' or 'desc', default: 'desc')

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "creator": "string",
      "allowDelegation": true,
      "metadata": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/collections/:collectionSymbol

Retrieves details for a specific NFT collection.

**Parameters:**
- `collectionSymbol` (path parameter) - The symbol of the collection to retrieve

**Response:**
```json
{
  "_id": "string",
  "symbol": "string",
  "name": "string",
  "creator": "string",
  "allowDelegation": true,
  "metadata": "string",
  "createdAt": "string"
}
```

### GET /nfts/collections/creator/:creatorName

Lists all NFT collections by a specific creator with pagination.

**Parameters:**
- `creatorName` (path parameter) - The name of the creator whose collections to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "creator": "string",
      "allowDelegation": true,
      "metadata": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/collections/stats

Retrieves statistics about NFT collections.

**Response:**
```json
{
  "topCollectionsBySize": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "creator": "string",
      "totalNfts": 0,
      "createdAt": "string"
    }
  ],
  "topCollectionsBySales": [
    {
      "_id": "string",
      "totalSales": 0,
      "totalVolume": 0
    }
  ]
}
```

### GET /nfts/instances

Lists all NFT instances with advanced filtering options.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `collectionSymbol` (optional) - Filter by collection symbol
- `owner` (optional) - Filter by owner account
- `createdAfter` (optional) - Filter NFTs created after a specific date
- `createdBefore` (optional) - Filter NFTs created before a specific date
- `metadataKey` (optional) - Filter by metadata key (requires metadataValue)
- `metadataValue` (optional) - Filter by metadata value (requires metadataKey)
- `sortBy` (optional) - Field to sort by (default: 'createdAt')
- `sortDirection` (optional) - Sort direction ('asc' or 'desc', default: 'desc')

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "collectionSymbol": "string",
      "instanceId": "string",
      "owner": "string",
      "metadata": "string",
      "properties": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/instances/collection/:collectionSymbol

Lists all NFT instances within a specific collection with pagination.

**Parameters:**
- `collectionSymbol` (path parameter) - The symbol of the collection whose instances to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "collectionSymbol": "string",
      "instanceId": "string",
      "owner": "string",
      "metadata": "string",
      "properties": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/instances/owner/:ownerName

Lists all NFT instances owned by a specific account with pagination.

**Parameters:**
- `ownerName` (path parameter) - The name of the owner whose instances to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "collectionSymbol": "string",
      "instanceId": "string",
      "owner": "string",
      "metadata": "string",
      "properties": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/instances/id/:nftId

Retrieves details for a specific NFT instance.

**Parameters:**
- `nftId` (path parameter) - The ID of the NFT instance to retrieve (format: "COLLECTION-INSTANCE")

**Response:**
```json
{
  "_id": "string",
  "collectionSymbol": "string",
  "instanceId": "string",
  "owner": "string",
  "metadata": "string",
  "properties": "string",
  "createdAt": "string"
}
```

### GET /nfts/instances/id/:nftId/history

Retrieves the ownership and transaction history for a specific NFT.

**Parameters:**
- `nftId` (path parameter) - The ID of the NFT instance to retrieve history for

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "type": 0,
      "data": {},
      "sender": "string",
      "ts": 0,
      "ref": "string",
      "hash": "string"
    }
  ],
  "nftId": "string",
  "collectionSymbol": "string",
  "instanceId": "string",
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/listings

Lists all active NFT listings with pagination and filtering.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)
- `status` (optional) - Filter by listing status (default: "ACTIVE")
- `collectionSymbol` (optional) - Filter by collection symbol
- `seller` (optional) - Filter by seller account
- `paymentTokenSymbol` (optional) - Filter by payment token symbol
- `minPrice` (optional) - Filter listings with price >= minPrice
- `maxPrice` (optional) - Filter listings with price <= maxPrice
- `sortBy` (optional) - Field to sort by (default: 'createdAt')
- `sortDirection` (optional) - Sort direction ('asc' or 'desc', default: 'desc')

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "collectionSymbol": "string",
      "instanceId": "string",
      "seller": "string",
      "price": 0,
      "paymentTokenSymbol": "string",
      "status": "string",
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /nfts/listings/id/:listingId

Retrieves details for a specific NFT listing.

**Parameters:**
- `listingId` (path parameter) - The ID of the listing to retrieve

**Response:**
```json
{
  "_id": "string",
  "collectionSymbol": "string",
  "instanceId": "string",
  "seller": "string",
  "price": 0,
  "paymentTokenSymbol": "string",
  "status": "string",
  "createdAt": "string"
}
```

### GET /nfts/listings/nft/:nftInstanceId

Retrieves the active listing for a specific NFT instance.

**Parameters:**
- `nftInstanceId` (path parameter) - The ID of the NFT instance whose listing to retrieve (format: "COLLECTION-INSTANCE")

**Response:**
```json
{
  "_id": "string",
  "collectionSymbol": "string",
  "instanceId": "string",
  "seller": "string",
  "price": 0,
  "paymentTokenSymbol": "string",
  "status": "string",
  "createdAt": "string"
}
```

### GET /nfts/listings/nft/:nftInstanceId/history

Retrieves the price history for an NFT, including all listings and sales.

**Parameters:**
- `nftInstanceId` (path parameter) - The ID of the NFT instance to retrieve price history for

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "nftId": "string",
  "listings": {
    "data": [
      {
        "_id": "string",
        "collectionSymbol": "string",
        "instanceId": "string",
        "seller": "string",
        "price": 0,
        "paymentTokenSymbol": "string",
        "status": "string",
        "createdAt": "string"
      }
    ],
    "total": 0
  },
  "sales": {
    "data": [
      {
        "type": 6,
        "data": {
          "collectionSymbol": "string",
          "instanceId": "string",
          "price": 0
        },
        "sender": "string",
        "ts": 0,
        "ref": "string",
        "hash": "string"
      }
    ],
    "total": 0
  },
  "limit": 10,
  "skip": 0
}
```

## Pools

### GET /pools

Lists all liquidity pools with pagination.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "tokenA_symbol": "string",
      "tokenA_issuer": "string",
      "tokenA_reserve": 0,
      "tokenB_symbol": "string",
      "tokenB_issuer": "string",
      "tokenB_reserve": 0,
      "totalLpTokens": 0,
      "lpTokenSymbol": "string",
      "feeRate": 0,
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /pools/:poolId

Retrieves details for a specific liquidity pool.

**Parameters:**
- `poolId` (path parameter) - The ID of the pool to retrieve

**Response:**
```json
{
  "_id": "string",
  "tokenA_symbol": "string",
  "tokenA_issuer": "string",
  "tokenA_reserve": 0,
  "tokenB_symbol": "string",
  "tokenB_issuer": "string",
  "tokenB_reserve": 0,
  "totalLpTokens": 0,
  "lpTokenSymbol": "string",
  "feeRate": 0,
  "createdAt": "string"
}
```

### GET /pools/token/:tokenSymbol

Lists all liquidity pools that include a specific token with pagination.

**Parameters:**
- `tokenSymbol` (path parameter) - The symbol of the token whose pools to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "tokenA_symbol": "string",
      "tokenA_issuer": "string",
      "tokenA_reserve": 0,
      "tokenB_symbol": "string",
      "tokenB_issuer": "string",
      "tokenB_reserve": 0,
      "totalLpTokens": 0,
      "lpTokenSymbol": "string",
      "feeRate": 0,
      "createdAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /pools/positions/user/:userId

Lists all liquidity positions for a specific user with pagination.

**Parameters:**
- `userId` (path parameter) - The ID of the user whose positions to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "provider": "string",
      "poolId": "string",
      "lpTokenBalance": 0,
      "createdAt": "string",
      "lastUpdatedAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /pools/positions/pool/:poolId

Lists all liquidity positions for a specific pool with pagination.

**Parameters:**
- `poolId` (path parameter) - The ID of the pool whose positions to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "provider": "string",
      "poolId": "string",
      "lpTokenBalance": 0,
      "createdAt": "string",
      "lastUpdatedAt": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /pools/positions/:positionId

Retrieves details for a specific liquidity position.

**Parameters:**
- `positionId` (path parameter) - The ID of the position to retrieve

**Response:**
```json
{
  "_id": "string",
  "provider": "string",
  "poolId": "string",
  "lpTokenBalance": 0,
  "createdAt": "string",
  "lastUpdatedAt": "string"
}
```

### GET /pools/positions/user/:userId/pool/:poolId

Retrieves a specific user's liquidity position in a specific pool.

**Parameters:**
- `userId` (path parameter) - The ID of the user
- `poolId` (path parameter) - The ID of the pool

**Response:**
```json
{
  "_id": "string",
  "provider": "string",
  "poolId": "string",
  "lpTokenBalance": 0,
  "createdAt": "string",
  "lastUpdatedAt": "string"
}
```

### GET /pools/route-swap

Finds the best swap route between two tokens using available liquidity pools, considering up to 4 hops. This endpoint helps in constructing the `hops` array for a `pool_swap` transaction.

**Query Parameters:**
- `fromTokenSymbol` (required) - The symbol of the token to swap from.
- `toTokenSymbol` (required) - The symbol of the token to swap to.
- `amountIn` (required) - The amount of `fromTokenSymbol` to swap (numeric string).

**Response (Success):**
```json
{
  "success": true,
  "fromTokenSymbol": "string",
  "toTokenSymbol": "string",
  "amountIn": 0,
  "bestRoute": {
    "hops": [
      {
        "poolId": "string",
        "tokenIn": "string",
        "tokenOut": "string",
        "amountOut": 0
      }
    ],
    "totalAmountOut": 0
  }
}
```

## Tokens

### GET /tokens

Lists all registered tokens with pagination.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "precision": 0,
      "maxSupply": 0,
      "currentSupply": 0,
      "creator": "string",
      "mintable": true,
      "burnable": true,
      "description": "string",
      "logoUrl": "string",
      "websiteUrl": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /tokens/:symbol

Retrieves details for a specific token.

**Parameters:**
- `symbol` (path parameter) - The symbol of the token to retrieve

**Response:**
```json
{
  "_id": "string",
  "symbol": "string",
  "name": "string",
  "precision": 0,
  "maxSupply": 0,
  "currentSupply": 0,
  "creator": "string",
  "mintable": true,
  "burnable": true,
  "description": "string",
  "logoUrl": "string",
  "websiteUrl": "string"
}
```

### GET /tokens/issuer/:issuerName

Lists tokens created by a specific issuer with pagination.

**Parameters:**
- `issuerName` (path parameter) - The name of the issuer whose tokens to retrieve

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "precision": 0,
      "maxSupply": 0,
      "currentSupply": 0,
      "creator": "string",
      "mintable": true,
      "burnable": true,
      "description": "string",
      "logoUrl": "string",
      "websiteUrl": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /tokens/name/:searchName

Searches for tokens by name (partial match) with pagination.

**Parameters:**
- `searchName` (path parameter) - The search string to match against token names

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "_id": "string",
      "symbol": "string",
      "name": "string",
      "precision": 0,
      "maxSupply": 0,
      "currentSupply": 0,
      "creator": "string",
      "mintable": true,
      "burnable": true,
      "description": "string",
      "logoUrl": "string",
      "websiteUrl": "string"
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

## Witnesses

### GET /witnesses

Lists top witnesses by vote weight with pagination.

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "name": "string",
      "witnessPublicKey": "string",
      "totalVoteWeight": 0
    }
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

### GET /witnesses/:name/details

Retrieves account details for a specific witness.

**Parameters:**
- `name` (path parameter) - The name of the witness account to retrieve

**Response:**
```json
{
  "name": "string",
  "witnessPublicKey": "string",
  "totalVoteWeight": 0,
  "balance": 0,
  "votedWitnesses": []
}
```

### GET /witnesses/votescastby/:voterName

Lists witnesses that a specific account has voted for.

**Parameters:**
- `voterName` (path parameter) - The name of the voter account

**Response:**
```json
{
  "votedWitnesses": [
    "string"
  ]
}
```

### GET /witnesses/votersfor/:witnessName

Lists accounts that voted for a specific witness with pagination.

**Parameters:**
- `witnessName` (path parameter) - The name of the witness account

**Query Parameters:**
- `limit` (optional) - Number of results to return (default: 10)
- `offset` (optional) - Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    "string"
  ],
  "total": 0,
  "limit": 10,
  "skip": 0
}
```

## Transaction Payloads

This section describes the expected JSON payloads for various `custom_json` operations with `id: "sidechain"`.

### `pool_swap` (Type ID: 17)

Executes a token swap. Can be a direct swap within a single pool or a routed swap through multiple pools.

**Contract Name:** `pool_swap`

**Payload for Direct Swap (`json.payload`):
```json
{
  "poolId": "string",          // ID of the liquidity pool for the direct swap
  "tokenInSymbol": "string",  // Symbol of the token being sent
  "tokenOutSymbol": "string", // Symbol of the token to be received
  "amountIn": "string",        // Amount of tokenInSymbol to swap (as a string to preserve precision)
  "minAmountOut": "string"   // Minimum amount of tokenOutSymbol expected (as a string, for slippage protection)
}
```

**Payload for Routed Swap (`json.payload`):
```json
{
  "fromTokenSymbol": "string", // Symbol of the initial token being sent
  "toTokenSymbol": "string",   // Symbol of the final token to be received
  "amountIn": "string",       // Amount of fromTokenSymbol to swap (as a string to preserve precision)
  "minAmountOut": "string",   // Minimum amount of toTokenSymbol expected (as a string, for slippage protection)
  "hops": [
    {
      "poolId": "string",      // ID of the liquidity pool for this hop
      "tokenIn": "string",    // Symbol of the token input to this specific pool hop
      "tokenOut": "string"   // Symbol of the token output from this specific pool hop
      // Note: amountOut for each hop is calculated by the chain
    }
    // ... up to 4 hops (or as defined by chain limits)
  ]
}
```

**Note on Routed Swaps:** The `GET /pools/route-swap` endpoint can be used to determine the optimal `hops` array. 