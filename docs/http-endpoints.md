# HTTP API Endpoints

This document outlines the available HTTP API endpoints for interacting with the sidechain.

**Common Query Parameters for Pagination:**

*   `limit` (number, optional, default: 10): Number of items to return.
*   `offset` (number, optional, default: 0): Number of items to skip.

## `/accounts`

Handler: `src/modules/http/accounts.ts`

*   **GET `/`**
    *   Description: List accounts with pagination and filtering.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `hasToken` (string, optional): Filter accounts holding a specific token (e.g., `ECH`). Returns accounts where the balance of this token is > 0.
        *   `isWitness` (string, optional, e.g. `true`): Filter for accounts that are registered witnesses (have a `witnessPublicKey`).
        *   `sortBy` (string, optional, default: `name`): Field to sort by (e.g., `name`, `totalVoteWeight`).
        *   `sortDirection` (string, optional, default: `asc`): Sort direction (`asc` or `desc`).
    *   Response: `{ success: boolean, data: Account[], total: number, limit: number, skip: number }`

*   **GET `/:name`**
    *   Description: Get a specific account by its name or ObjectId.
    *   Path Parameters:
        *   `name` (string): The account name or ObjectId.
    *   Response: `{ success: boolean, account: Account }` or `{ success: false, error: string }`

*   **GET `/:name/transactions`**
    *   Description: Get transactions involving a specific account (as sender), sorted by most recent.
    *   Path Parameters:
        *   `name` (string): The account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `type` (number, optional): Filter transactions by a specific `TransactionType` number.
    *   Response: `{ success: boolean, data: Transaction[], total: number, limit: number, skip: number }` or `{ success: false, error: string }`

*   **GET `/:name/tokens`**
    *   Description: Get all token balances held by a specific account.
    *   Path Parameters:
        *   `name` (string): The account name or ObjectId.
    *   Response: `{ success: boolean, account: string, tokens: { symbol: string, amount: number }[] }` or `{ success: false, error: string }`

## `/blocks`

Handler: `src/modules/http/blocks.ts`

*   **GET `/`**
    *   Description: Get a range of blocks with pagination and filtering.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `hasTransactionType` (number, optional): Filter blocks containing a specific `TransactionType` number.
        *   `minTimestamp` (number, optional): Filter blocks with a timestamp greater than or equal to this value.
        *   `maxTimestamp` (number, optional): Filter blocks with a timestamp less than or equal to this value.
        *   `sortDirection` (string, optional, default: `desc` for height): Sort direction for block height (`asc` or `desc`).
    *   Response: `{ success: boolean, data: Block[], total: number, limit: number, skip: number }`

*   **GET `/latest`**
    *   Description: Returns the latest block processed by the node.
    *   Response: `{ success: boolean, block: Block }` or `{ success: false, error: string }`

*   **GET `/height/:height`**
    *   Description: Get a specific block by its height (block number).
    *   Path Parameters:
        *   `height` (number): The block height.
    *   Response: `{ success: boolean, block: Block }` or `{ success: false, error: string }`

*   **GET `/hash/:hash`**
    *   Description: Get a specific block by its hash.
    *   Path Parameters:
        *   `hash` (string): The block hash.
    *   Response: `{ success: boolean, block: Block }` or `{ success: false, error: string }`

*   **GET `/:height/transactions`**
    *   Description: Get all transactions included in a specific block.
    *   Path Parameters:
        *   `height` (number): The block height.
    *   Response: `{ success: boolean, blockHeight: number, transactions: Transaction[] }` or `{ success: false, error: string }`

## `/farms`

Handler: `src/modules/http/farms.ts`

*   **GET `/`**
    *   Description: List all farms with pagination and filtering.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `status` (string, optional): Filter farms by status (e.g., `ACTIVE`, `ENDED`).
        *   `rewardTokenSymbol` (string, optional): Filter farms by their reward token symbol.
    *   Response: `{ data: Farm[], total: number, limit: number, skip: number }`

*   **GET `/:farmId`**
    *   Description: Get details of a specific farm.
    *   Path Parameters:
        *   `farmId` (string): The ID of the farm.
    *   Response: `Farm` object or `{ message: string }` if not found.

*   **GET `/positions/user/:userId`**
    *   Description: List farm positions (stakes) for a specific user.
    *   Path Parameters:
        *   `userId` (string): The user's account name (staker).
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: UserFarmPosition[], total: number, limit: number, skip: number }`

*   **GET `/positions/farm/:farmId`**
    *   Description: List all user positions (stakes) in a specific farm.
    *   Path Parameters:
        *   `farmId` (string): The ID of the farm.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: UserFarmPosition[], total: number, limit: number, skip: number }`

*   **GET `/positions/:positionId`**
    *   Description: Get a specific user farm position by its composite ID (e.g., `stakerName-farmId`).
    *   Path Parameters:
        *   `positionId` (string): The composite ID of the user's farm position.
    *   Response: `UserFarmPosition` object or `{ message: string }` if not found.

*   **GET `/positions/user/:userId/farm/:farmId`**
    *   Description: Get a specific user's farm position in a specific farm.
    *   Path Parameters:
        *   `userId` (string): The user's account name (staker).
        *   `farmId` (string): The ID of the farm.
    *   Response: `UserFarmPosition` object or `{ message: string }` if not found.

## `/launchpad`

Handler: `src/modules/http/launchpad.ts`

*   **GET `/`**
    *   Description: List all launchpad projects.
    *   Response: `Launchpad[]` or `{ message: string }`

*   **GET `/:launchpadId`**
    *   Description: Get details of a specific launchpad project.
    *   Path Parameters:
        *   `launchpadId` (string): The ID of the launchpad.
    *   Response: `Launchpad` object or `{ message: string }` if not found.

*   **GET `/:launchpadId/user/:userId`**
    *   Description: Get a user's participation details in a specific launchpad.
    *   Path Parameters:
        *   `launchpadId` (string): The ID of the launchpad.
        *   `userId` (string): The user's account name.
    *   Response: Participant object or `{ message: string }` if not found.

*   **GET `/:launchpadId/user/:userId/claimable`**
    *   Description: Get the amount of tokens a user can claim from a specific launchpad.
    *   Path Parameters:
        *   `launchpadId` (string): The ID of the launchpad.
        *   `userId` (string): The user's account name.
    *   Response: `{ launchpadId: string, userId: string, totalAllocated: number, claimed: number, claimable: number }` or `{ message: string }`

## `/markets`

Handler: `src/modules/http/markets.ts`

*   **GET `/pairs`**
    *   Description: List all trading pairs with pagination and filtering.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `status` (string, optional): Filter pairs by status.
    *   Response: `{ data: TradingPair[], total: number, limit: number, skip: number }`

*   **GET `/pairs/:pairId`**
    *   Description: Get details of a specific trading pair.
    *   Path Parameters:
        *   `pairId` (string): The ID of the trading pair (e.g., `ECH-STM`).
    *   Response: `TradingPair` object or `{ message: string }` if not found.

*   **GET `/orders/pair/:pairId`**
    *   Description: List orders for a specific trading pair.
    *   Path Parameters:
        *   `pairId` (string): The ID of the trading pair.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `status` (string, optional): Filter orders by status (e.g., `OPEN`, `FILLED`, `CANCELLED`).
        *   `side` (string, optional): Filter orders by side (`BUY` or `SELL`).
        *   `userId` (string, optional): Filter orders by user.
    *   Response: `{ data: Order[], total: number, limit: number, skip: number }`

*   **GET `/orders/user/:userId`**
    *   Description: List orders for a specific user.
    *   Path Parameters:
        *   `userId` (string): The user's account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `pairId` (string, optional): Filter orders by trading pair.
        *   `status` (string, optional): Filter orders by status.
        *   `side` (string, optional): Filter orders by side.
    *   Response: `{ data: Order[], total: number, limit: number, skip: number }`

*   **GET `/orders/:orderId`**
    *   Description: Get details of a specific order.
    *   Path Parameters:
        *   `orderId` (string): The ID of the order.
    *   Response: `Order` object or `{ message: string }` if not found.

*   **GET `/trades/pair/:pairId`**
    *   Description: List trades for a specific trading pair, sorted by newest first.
    *   Path Parameters:
        *   `pairId` (string): The ID of the trading pair.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `fromTimestamp` (number, optional): Filter trades from this UNIX timestamp.
        *   `toTimestamp` (number, optional): Filter trades up to this UNIX timestamp.
    *   Response: `{ data: Trade[], total: number, limit: number, skip: number }`

*   **GET `/trades/order/:orderId`**
    *   Description: List trades involving a specific order ID (either as maker or taker).
    *   Path Parameters:
        *   `orderId` (string): The ID of the order.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Trade[], total: number, limit: number, skip: number }` or `{ message: string }` if no trades found.


*   **GET `/trades/:tradeId`**
    *   Description: Get details of a specific trade by its ID.
    *   Path Parameters:
        *   `tradeId` (string): The ID of the trade.
    *   Response: `Trade` object or `{ message: string }` if not found.

## `/mine`

Handler: `src/modules/http/mine.ts`

*   **GET `/`**
    *   Description: Manually trigger the mining of a new block. (Primarily for development/testing)
    *   Response: `{ success: boolean, block?: Block, error?: string }`

## `/nfts`

Handler: `src/modules/http/nfts.ts`

### Collections

*   **GET `/collections`**
    *   Description: List all NFT collections with filtering and sorting.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `creator` (string, optional): Filter by collection creator's account name.
        *   `allowDelegation` (boolean, optional): Filter by `allowDelegation` status.
        *   `createdAfter` (string, optional, ISO Date): Filter collections created on or after this date.
        *   `createdBefore` (string, optional, ISO Date): Filter collections created on or before this date.
        *   `nameSearch` (string, optional): Case-insensitive search for collections by name.
        *   `sortBy` (string, optional, default: `createdAt`): Field to sort by.
        *   `sortDirection` (string, optional, default: `desc`): Sort direction (`asc` or `desc`).
    *   Response: `{ data: NFTCollection[], total: number, limit: number, skip: number }`

*   **GET `/collections/:collectionSymbol`**
    *   Description: Get a specific NFT collection by its symbol.
    *   Path Parameters:
        *   `collectionSymbol` (string): The symbol of the NFT collection (e.g., `MYCOL`).
    *   Response: `NFTCollection` object or `{ message: string }` if not found.

*   **GET `/collections/creator/:creatorName`**
    *   Description: List NFT collections created by a specific account.
    *   Path Parameters:
        *   `creatorName` (string): The creator's account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTCollection[], total: number, limit: number, skip: number }` or `{ message: string }` if none found.

### Instances (NFTs)

*   **GET `/instances`**
    *   Description: List all NFT instances with advanced filtering and sorting.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `collectionSymbol` (string, optional): Filter by collection symbol.
        *   `owner` (string, optional): Filter by current owner's account name.
        *   `createdAfter` (string, optional, ISO Date): Filter NFTs minted on or after this date.
        *   `createdBefore` (string, optional, ISO Date): Filter NFTs minted on or before this date.
        *   `metadataKey` (string, optional): Key for metadata search (e.g., `color`). Requires `metadataValue`.
        *   `metadataValue` (string, optional): Value for metadata search (e.g., `red`). Case-insensitive regex search.
        *   `sortBy` (string, optional, default: `createdAt`): Field to sort by.
        *   `sortDirection` (string, optional, default: `desc`): Sort direction (`asc` or `desc`).
    *   Response: `{ data: NFTInstance[], total: number, limit: number, skip: number }` or `{ message: string }` if none found.


*   **GET `/instances/collection/:collectionSymbol`**
    *   Description: List all NFT instances within a specific collection.
    *   Path Parameters:
        *   `collectionSymbol` (string): The symbol of the NFT collection.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTInstance[], total: number, limit: number, skip: number }` or `{ message: string }` if none found.

*   **GET `/instances/owner/:ownerName`**
    *   Description: List all NFT instances owned by a specific account.
    *   Path Parameters:
        *   `ownerName` (string): The owner's account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTInstance[], total: number, limit: number, skip: number }` or `{ message: string }` if none found.

*   **GET `/instances/id/:nftId`**
    *   Description: Get a specific NFT instance by its full ID (e.g., `MYCOL-001`).
    *   Path Parameters:
        *   `nftId` (string): The full ID of the NFT instance.
    *   Response: `NFTInstance` object or `{ message: string }` if not found.

*   **GET `/instances/id/:nftId/history`**
    *   Description: Get ownership and transaction history for a specific NFT.
    *   Path Parameters:
        *   `nftId` (string): The full ID of the NFT instance.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTHistoryEntry[], total: number, limit: number, skip: number }` (Structure of `NFTHistoryEntry` might include event type, involved parties, timestamp, transaction ID).

*   **GET `/instances/id/:nftId/delegations`**
    *   Description: Get active delegation information for a specific NFT.
    *   Path Parameters:
        *   `nftId` (string): The full ID of the NFT instance.
    *   Response: `NFTDelegation` object or `{ message: string }` if not delegated or not found.

*   **GET `/instances/delegatedto/:userName`**
    *   Description: List NFT instances currently delegated to a specific user.
    *   Path Parameters:
        *   `userName` (string): The account name of the delegatee.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTInstance[], total: number, limit: number, skip: number }`

### Market Listings

*   **GET `/market/listings`**
    *   Description: List all active NFT market listings.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
        *   `collectionSymbol` (string, optional): Filter by collection symbol.
        *   `seller` (string, optional): Filter by seller's account name.
        *   `priceMin` (number, optional): Filter by minimum price.
        *   `priceMax` (number, optional): Filter by maximum price.
        *   `paymentSymbol` (string, optional): Filter by the symbol of the payment token.
        *   `sortBy` (string, optional, default: `listedAt`): Field to sort by (e.g., `price`, `listedAt`).
        *   `sortDirection` (string, optional, default: `desc`): Sort direction (`asc` or `desc`).
    *   Response: `{ data: NFTMarketListing[], total: number, limit: number, skip: number }`

*   **GET `/market/listings/nft/:nftId`**
    *   Description: Get the active market listing for a specific NFT.
    *   Path Parameters:
        *   `nftId` (string): The full ID of the NFT instance.
    *   Response: `NFTMarketListing` object or `{ message: string }` if not listed or not found.

*   **GET `/market/listings/seller/:sellerName`**
    *   Description: List active market listings by a specific seller.
    *   Path Parameters:
        *   `sellerName` (string): The seller's account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTMarketListing[], total: number, limit: number, skip: number }`

*   **GET `/market/listings/collection/:collectionSymbol`**
    *   Description: List active market listings for a specific NFT collection.
    *   Path Parameters:
        *   `collectionSymbol` (string): The symbol of the NFT collection.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: NFTMarketListing[], total: number, limit: number, skip: number }`

## `/peers`

Handler: `src/modules/http/peers.ts`

*   **GET `/`**
    *   Description: List currently connected P2P peers.
    *   Response: `{ success: boolean, peers: string[] }` (Array of peer WebSocket URLs)

## `/pools`

Handler: `src/modules/http/pools.ts`

### Liquidity Pools

*   **GET `/`**
    *   Description: List all liquidity pools with pagination.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Pool[], total: number, limit: number, skip: number }`

*   **GET `/:poolId`**
    *   Description: Get details of a specific liquidity pool.
    *   Path Parameters:
        *   `poolId` (string): The ID of the liquidity pool (e.g., `ECH-STM`).
    *   Response: `Pool` object or `{ message: string }` if not found.

*   **GET `/token/:tokenSymbol`**
    *   Description: List liquidity pools that include a specific token.
    *   Path Parameters:
        *   `tokenSymbol` (string): The symbol of the token.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Pool[], total: number, limit: number, skip: number }`

### User Liquidity Positions

*   **GET `/positions/user/:userId`**
    *   Description: List liquidity positions for a specific user.
    *   Path Parameters:
        *   `userId` (string): The user's account name (provider).
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: UserLiquidityPosition[], total: number, limit: number, skip: number }`

*   **GET `/positions/pool/:poolId`**
    *   Description: List all user liquidity positions in a specific pool.
    *   Path Parameters:
        *   `poolId` (string): The ID of the liquidity pool.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: UserLiquidityPosition[], total: number, limit: number, skip: number }`

*   **GET `/positions/:positionId`**
    *   Description: Get a specific user liquidity position by its composite ID (e.g., `providerName-poolId`).
    *   Path Parameters:
        *   `positionId` (string): The composite ID of the user's liquidity position.
    *   Response: `UserLiquidityPosition` object or `{ message: string }` if not found.

*   **GET `/positions/user/:userId/pool/:poolId`**
    *   Description: Get a specific user's liquidity position in a specific pool.
    *   Path Parameters:
        *   `userId` (string): The user's account name (provider).
        *   `poolId` (string): The ID of the pool.
    *   Response: `UserLiquidityPosition` object or `{ message: string }` if not found.

### Swap Routing

*   **GET `/route-swap`**
    *   Description: Find potential swap routes between two tokens.
    *   Query Parameters:
        *   `fromTokenSymbol` (string, required): Symbol of the token to swap from.
        *   `toTokenSymbol` (string, required): Symbol of the token to swap to.
        *   `amountIn` (number, required): The amount of `fromTokenSymbol` to swap.
    *   Response: `{ routes: TradeRoute[] }` where `TradeRoute` details hops and amounts, or `{ message: string }` on error.

*   **POST `/autoSwapRoute`**
    *   Description: Execute an automatic swap using the best available route.
    *   Request Body:
        ```json
        {
          "tokenIn": "STEEM",
          "tokenOut": "ECH",
          "amountIn": 1,
          "slippage": 0.5
        }
        ```
    *   Response (Success): `{ success: true, message: string, transactionId: string, route: TradeRoute, executedAmountIn: string, executedAmountOut: string }`
    *   Response (Error): `{ success: false, message: string, route?: TradeRoute }`
    *   Notes: Currently supports single-hop routes only. Multi-hop routes return 501 Not Implemented.

## `/tokens`

Handler: `src/modules/http/tokens.ts`

*   **GET `/`**
    *   Description: List all registered tokens with pagination.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Token[], total: number, limit: number, skip: number }`

*   **GET `/:symbol`**
    *   Description: Get details of a specific token by its symbol.
    *   Path Parameters:
        *   `symbol` (string): The token symbol (e.g., `ECH`).
    *   Response: `Token` object or `{ message: string }` if not found.

*   **GET `/issuer/:issuerName`**
    *   Description: List tokens created by a specific issuer.
    *   Path Parameters:
        *   `issuerName` (string): The account name of the issuer.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Token[], total: number, limit: number, skip: number }`

*   **GET `/name/:searchName`**
    *   Description: Search for tokens by name (case-insensitive, partial match).
    *   Path Parameters:
        *   `searchName` (string): The search term for the token name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Token[], total: number, limit: number, skip: number }`

## `/witnesses`

Handler: `src/modules/http/witnesses.ts`

*   **GET `/`**
    *   Description: List top witnesses by total vote weight, with pagination.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: Account[], total: number, limit: number, skip: number }` (Accounts are witness accounts)

*   **GET `/:name/details`**
    *   Description: Get account details for a specific witness (similar to `/accounts/:name`).
    *   Path Parameters:
        *   `name` (string): The witness's account name.
    *   Response: `Account` object or `{ message: string }` if not found.

*   **GET `/votescastby/:voterName`**
    *   Description: List witnesses that a specific account has voted for.
    *   Path Parameters:
        *   `voterName` (string): The account name of the voter.
    *   Response: `{ votedWitnesses: string[] }` or `{ message: string }` if voter not found.

*   **GET `/votersfor/:witnessName`**
    *   Description: List accounts that have voted for a specific witness, with pagination.
    *   Path Parameters:
        *   `witnessName` (string): The witness's account name.
    *   Query Parameters:
        *   `limit`, `offset` (see Common Query Parameters)
    *   Response: `{ data: string[], total: number, limit: number, skip: number }` (Array of voter names) 