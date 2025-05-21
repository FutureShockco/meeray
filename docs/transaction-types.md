# Echelon Blockchain Transaction Types

This document provides a comprehensive list of all transaction types implemented in the Echelon blockchain, including their data structures and purposes.

## 1. NFT Transactions

### NFT Create Collection (Type 1)
- **File**: `src/transactions/nft/nft-create-collection.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftCreateCollectionData {
    // TODO: Define the data structure for NFT_CREATE_COLLECTION
  }
  ```

### NFT Mint (Type 2)
- **File**: `src/transactions/nft/nft-mint.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftMintData {
    // TODO: Define the data structure for NFT_MINT
  }
  ```

### NFT Transfer (Type 3)
- **File**: `src/transactions/nft/nft-transfer.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftTransferData {
    // TODO: Define the data structure for NFT_TRANSFER
  }
  ```

### NFT List Item (Type 4)
- **File**: `src/transactions/nft/nft-list-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftListItemData {
    // TODO: Define the data structure for NFT_LIST_ITEM
  }
  ```

### NFT Delist Item (Type 5)
- **File**: `src/transactions/nft/nft-delist-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftDelistItemData {
    // TODO: Define the data structure for NFT_DELIST_ITEM
  }
  ```

### NFT Buy Item (Type 6)
- **File**: `src/transactions/nft/nft-buy-item.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface NftBuyItemData {
    // TODO: Define the data structure for NFT_BUY_ITEM
  }
  ```

## 2. Market Transactions

### Market Create Pair (Type 7)
- **File**: `src/transactions/market/market-create-pair.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface MarketCreatePairData {
    // TODO: Define the data structure for MARKET_CREATE_PAIR
  }
  ```

### Market Place Order (Type 8)
- **File**: `src/transactions/market/market-place-order.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface MarketPlaceOrderData {
    // TODO: Define the data structure for MARKET_PLACE_ORDER
  }
  ```

### Market Cancel Order (Type 9)
- **File**: `src/transactions/market/market-cancel-order.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface MarketCancelOrderData {
    // TODO: Define the data structure for MARKET_CANCEL_ORDER
  }
  ```

## 3. Farm Transactions

### Farm Create (Type 10)
- **File**: `src/transactions/farm/farm-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface FarmCreateData {
    // TODO: Define the data structure for FARM_CREATE
  }
  ```

### Farm Stake (Type 11)
- **File**: `src/transactions/farm/farm-stake.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface FarmStakeData {
    // TODO: Define the data structure for FARM_STAKE
  }
  ```

### Farm Unstake (Type 12)
- **File**: `src/transactions/farm/farm-unstake.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface FarmUnstakeData {
    // TODO: Define the data structure for FARM_UNSTAKE
  }
  ```

### Farm Claim Rewards (Type 13)
- **File**: `src/transactions/farm/farm-claim-rewards.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface FarmClaimRewardsData {
    // TODO: Define the data structure for FARM_CLAIM_REWARDS
  }
  ```

## 4. Pool Transactions

### Pool Create (Type 14)
- **File**: `src/transactions/pool/pool-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface PoolCreateData {
    // TODO: Define the data structure for POOL_CREATE
  }
  ```

### Pool Add Liquidity (Type 15)
- **File**: `src/transactions/pool/pool-add-liquidity.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface PoolAddLiquidityData {
    // TODO: Define the data structure for POOL_ADD_LIQUIDITY
  }
  ```

### Pool Remove Liquidity (Type 16)
- **File**: `src/transactions/pool/pool-remove-liquidity.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface PoolRemoveLiquidityData {
    // TODO: Define the data structure for POOL_REMOVE_LIQUIDITY
  }
  ```

### Pool Swap (Type 17)
- **File**: `src/transactions/pool/pool-swap.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface PoolSwapData {
    // TODO: Define the data structure for POOL_SWAP
  }
  ```

## 5. Token Transactions

### Token Create (Type 18)
- **File**: `src/transactions/token/token-create.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface TokenCreateData {
    // TODO: Define the data structure for TOKEN_CREATE
  }
  ```

### Token Mint (Type 19)
- **File**: `src/transactions/token/token-mint.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface TokenMintData {
    // TODO: Define the data structure for TOKEN_MINT
  }
  ```

### Token Transfer (Type 20)
- **File**: `src/transactions/token/token-transfer.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface TokenTransferData {
    // TODO: Define the data structure for TOKEN_TRANSFER
  }
  ```

### Token Update (Type 21)
- **File**: `src/transactions/token/token-update.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface TokenUpdateData {
    // TODO: Define the data structure for TOKEN_UPDATE
  }
  ```

## 6. Witness Transactions

### Witness Register (Type 22)
- **File**: `src/transactions/witness/witness-register.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface WitnessRegisterData {
    // TODO: Define the data structure for WITNESS_REGISTER
  }
  ```

### Witness Vote (Type 23)
- **File**: `src/transactions/witness/witness-vote.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface WitnessVoteData {
    // TODO: Define the data structure for WITNESS_VOTE
  }
  ```

### Witness Unvote (Type 24)
- **File**: `src/transactions/witness/witness-unvote.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface WitnessUnvoteData {
    // TODO: Define the data structure for WITNESS_UNVOTE
  }
  ```

## 7. Launchpad Transactions

### Launchpad Launch Token (Type 25)
- **File**: `src/transactions/launchpad/launchpad-launch-token.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface LaunchpadLaunchTokenData {
    // TODO: Define the data structure for LAUNCHPAD_LAUNCH_TOKEN
  }
  ```

### Launchpad Participate Presale (Type 26)
- **File**: `src/transactions/launchpad/launchpad-participate-presale.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface LaunchpadParticipatePresaleData {
    // TODO: Define the data structure for LAUNCHPAD_PARTICIPATE_PRESALE
  }
  ```

### Launchpad Claim Tokens (Type 27)
- **File**: `src/transactions/launchpad/launchpad-claim-tokens.ts`
- **Purpose**: (Please describe the purpose of this transaction)
- **Data Structure**:
  ```typescript
  interface LaunchpadClaimTokensData {
    // TODO: Define the data structure for LAUNCHPAD_CLAIM_TOKENS
  }
  ``` 