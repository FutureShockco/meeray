export enum TransactionType {
  // NFT Transactions
  NFT_CREATE_COLLECTION = 1,
  NFT_MINT = 2,
  NFT_TRANSFER = 3,
  NFT_LIST_ITEM = 4,
  NFT_DELIST_ITEM = 5,
  NFT_BUY_ITEM = 6,
  
  // Market Transactions
  MARKET_CREATE_PAIR = 7,
  MARKET_PLACE_ORDER = 8,
  MARKET_CANCEL_ORDER = 9,
  
  // Farm Transactions
  FARM_CREATE = 10,
  FARM_STAKE = 11,
  FARM_UNSTAKE = 12,
  FARM_CLAIM_REWARDS = 13,
  
  // Pool Transactions
  POOL_CREATE = 14,
  POOL_ADD_LIQUIDITY = 15,
  POOL_REMOVE_LIQUIDITY = 16,
  POOL_SWAP = 17,
  
  // Token Transactions
  TOKEN_CREATE = 18,
  TOKEN_MINT = 19,
  TOKEN_TRANSFER = 20,
  TOKEN_UPDATE = 21,
  
  // Witness Transactions
  WITNESS_REGISTER = 22,
  WITNESS_VOTE = 23,
  WITNESS_UNVOTE = 24
}

export const transactions: { [key: number]: string } = {
  // NFT Transactions
  [TransactionType.NFT_CREATE_COLLECTION]: 'nft_create_collection',
  [TransactionType.NFT_MINT]: 'nft_mint',
  [TransactionType.NFT_TRANSFER]: 'nft_transfer',
  [TransactionType.NFT_LIST_ITEM]: 'nft_list_item',
  [TransactionType.NFT_DELIST_ITEM]: 'nft_delist_item',
  [TransactionType.NFT_BUY_ITEM]: 'nft_buy_item',
  
  // Market Transactions
  [TransactionType.MARKET_CREATE_PAIR]: 'market_create_pair',
  [TransactionType.MARKET_PLACE_ORDER]: 'market_place_order',
  [TransactionType.MARKET_CANCEL_ORDER]: 'market_cancel_order',
  
  // Farm Transactions
  [TransactionType.FARM_CREATE]: 'farm_create',
  [TransactionType.FARM_STAKE]: 'farm_stake',
  [TransactionType.FARM_UNSTAKE]: 'farm_unstake',
  [TransactionType.FARM_CLAIM_REWARDS]: 'farm_claim_rewards',
  
  // Pool Transactions
  [TransactionType.POOL_CREATE]: 'pool_create',
  [TransactionType.POOL_ADD_LIQUIDITY]: 'pool_add_liquidity',
  [TransactionType.POOL_REMOVE_LIQUIDITY]: 'pool_remove_liquidity',
  [TransactionType.POOL_SWAP]: 'pool_swap',
  
  // Token Transactions
  [TransactionType.TOKEN_CREATE]: 'token_create',
  [TransactionType.TOKEN_MINT]: 'token_mint',
  [TransactionType.TOKEN_TRANSFER]: 'token_transfer',
  [TransactionType.TOKEN_UPDATE]: 'token_update',
  
  // Witness Transactions
  [TransactionType.WITNESS_REGISTER]: 'witness_register',
  [TransactionType.WITNESS_VOTE]: 'witness_vote',
  [TransactionType.WITNESS_UNVOTE]: 'witness_unvote'
}; 