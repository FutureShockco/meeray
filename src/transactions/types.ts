export enum TransactionType {
  // NFT Transactions
  NFT_CREATE_COLLECTION = 1,
  NFT_MINT = 2,
  NFT_TRANSFER = 3,
  NFT_LIST_ITEM = 4,
  NFT_DELIST_ITEM = 5,
  NFT_BUY_ITEM = 6,
  NFT_UPDATE = 7,
  NFT_UPDATE_COLLECTION = 8,

  // Market Transactions
  MARKET_CANCEL_ORDER = 10,
  
  // Market Trading (Hybrid AMM + Orderbook)
  MARKET_TRADE = 11,

  // Farm Transactions
  FARM_CREATE = 12,
  FARM_STAKE = 13,
  FARM_UNSTAKE = 14,
  FARM_CLAIM_REWARDS = 15,
  FARM_UPDATE_WEIGHT = 16,

  // Pool Transactions
  POOL_CREATE = 17,
  POOL_ADD_LIQUIDITY = 18,
  POOL_REMOVE_LIQUIDITY = 19,
  POOL_SWAP = 20,

  // Token Transactions
  TOKEN_CREATE = 21,
  TOKEN_MINT = 22,
  TOKEN_TRANSFER = 23,
  TOKEN_UPDATE = 24,
  TOKEN_WITHDRAW = 25,
  
  // Witness Transactions
  WITNESS_REGISTER = 26,
  WITNESS_VOTE = 27,
  WITNESS_UNVOTE = 28,

  // Launchpad Transactions
  LAUNCHPAD_LAUNCH_TOKEN = 29,
  LAUNCHPAD_PARTICIPATE_PRESALE = 30,
  LAUNCHPAD_CLAIM_TOKENS = 31,

  // NEW NFT Auction/Bidding Transactions
  NFT_ACCEPT_BID = 32,
  NFT_CLOSE_AUCTION = 33,
  NFT_BATCH_OPERATIONS = 34,

  // Launchpad Lifecycle (Extended)
  LAUNCHPAD_UPDATE_STATUS = 35,
  LAUNCHPAD_FINALIZE_PRESALE = 36,
  LAUNCHPAD_SET_MAIN_TOKEN = 37,
  LAUNCHPAD_REFUND_PRESALE = 38,
  LAUNCHPAD_UPDATE_WHITELIST = 39,

  // NEW NFT Marketplace Transactions
  NFT_CANCEL_BID = 40,
  NFT_MAKE_OFFER = 41,
  NFT_ACCEPT_OFFER = 42,
  NFT_CANCEL_OFFER = 43
}

export const transactions: { [key: number]: string } = {
  // NFT Transactions
  [TransactionType.NFT_CREATE_COLLECTION]: 'nft_create_collection',
  [TransactionType.NFT_MINT]: 'nft_mint',
  [TransactionType.NFT_TRANSFER]: 'nft_transfer',
  [TransactionType.NFT_LIST_ITEM]: 'nft_list_item',
  [TransactionType.NFT_DELIST_ITEM]: 'nft_delist_item',
  [TransactionType.NFT_BUY_ITEM]: 'nft_buy_item',
  [TransactionType.NFT_UPDATE]: 'nft_update',
  [TransactionType.NFT_UPDATE_COLLECTION]: 'nft_update_collection',
  
  // Market Transactions
  [TransactionType.MARKET_CANCEL_ORDER]: 'market_cancel_order',

  // Market Trading (Unified AMM + Orderbook)
  [TransactionType.MARKET_TRADE]: 'market_trade',
  
  // Farm Transactions
  [TransactionType.FARM_CREATE]: 'farm_create',
  [TransactionType.FARM_STAKE]: 'farm_stake',
  [TransactionType.FARM_UNSTAKE]: 'farm_unstake',
  [TransactionType.FARM_CLAIM_REWARDS]: 'farm_claim_rewards',
  [TransactionType.FARM_UPDATE_WEIGHT]: 'farm_update_weight',
  
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
  [TransactionType.TOKEN_WITHDRAW]: 'token_withdraw',
  
  // Witness Transactions
  [TransactionType.WITNESS_REGISTER]: 'witness_register',
  [TransactionType.WITNESS_VOTE]: 'witness_vote',
  [TransactionType.WITNESS_UNVOTE]: 'witness_unvote',

  // Launchpad Transactions
  [TransactionType.LAUNCHPAD_LAUNCH_TOKEN]: 'launchpad_launch_token',
  [TransactionType.LAUNCHPAD_PARTICIPATE_PRESALE]: 'launchpad_participate_presale',
  [TransactionType.LAUNCHPAD_CLAIM_TOKENS]: 'launchpad_claim_tokens',

  // NEW NFT Auction/Bidding Transactions
  [TransactionType.NFT_ACCEPT_BID]: 'nft_accept_bid',
  [TransactionType.NFT_CLOSE_AUCTION]: 'nft_close_auction',
  [TransactionType.NFT_BATCH_OPERATIONS]: 'nft_batch_operations',

  // Launchpad Lifecycle (Extended)
  [TransactionType.LAUNCHPAD_UPDATE_STATUS]: 'launchpad_update_status',
  [TransactionType.LAUNCHPAD_FINALIZE_PRESALE]: 'launchpad_finalize_presale',
  [TransactionType.LAUNCHPAD_SET_MAIN_TOKEN]: 'launchpad_set_main_token',
  [TransactionType.LAUNCHPAD_REFUND_PRESALE]: 'launchpad_refund_presale',
  [TransactionType.LAUNCHPAD_UPDATE_WHITELIST]: 'launchpad_update_whitelist',

  // NEW NFT Marketplace Transactions
  [TransactionType.NFT_CANCEL_BID]: 'nft_cancel_bid',
  [TransactionType.NFT_MAKE_OFFER]: 'nft_make_offer',
  [TransactionType.NFT_ACCEPT_OFFER]: 'nft_accept_offer',
  [TransactionType.NFT_CANCEL_OFFER]: 'nft_cancel_offer'
}; 