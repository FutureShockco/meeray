export enum TransactionType {
  // Witness operations
  WITNESS_VOTE = 1,
  WITNESS_REGISTER = 2,
  WITNESS_UNVOTE = 3,

  // Token operations
  CREATE_TOKEN = 4,
  MINT_TOKEN = 5,
  TRANSFER_TOKEN = 6,

  // NFT operations
  CREATE_NFT_COLLECTION = 7,
  MINT_NFT = 8,
  TRANSFER_NFT = 9,

  // Market operations
  CREATE_MARKET = 10,
  PLACE_ORDER = 11,
  MATCH_ORDER = 12,

  // Pool operations
  CREATE_POOL = 13,
  STAKE = 14,
  UNSTAKE = 15,

  // Farm operations
  CREATE_FARM = 16,
  STAKE_FARM = 17,
  UNSTAKE_FARM = 18,
  CLAIM_FARM = 19
}

export const transactions: { [key: number]: string } = {
  // Witness operations
  [TransactionType.WITNESS_VOTE]: 'witness_vote',
  [TransactionType.WITNESS_REGISTER]: 'witness_register',
  [TransactionType.WITNESS_UNVOTE]: 'witness_unvote',

  // Token operations
  [TransactionType.CREATE_TOKEN]: 'create_token',
  [TransactionType.MINT_TOKEN]: 'mint_token',
  [TransactionType.TRANSFER_TOKEN]: 'transfer_token',

  // NFT operations
  [TransactionType.CREATE_NFT_COLLECTION]: 'create_nft_collection',
  [TransactionType.MINT_NFT]: 'mint_nft',
  [TransactionType.TRANSFER_NFT]: 'transfer_nft',

  // Market operations
  [TransactionType.CREATE_MARKET]: 'create_market',
  [TransactionType.PLACE_ORDER]: 'place_order',
  [TransactionType.MATCH_ORDER]: 'match_order',

  // Pool operations
  [TransactionType.CREATE_POOL]: 'create_pool',
  [TransactionType.STAKE]: 'stake',
  [TransactionType.UNSTAKE]: 'unstake',

  // Farm operations
  [TransactionType.CREATE_FARM]: 'create_farm',
  [TransactionType.STAKE_FARM]: 'stake_farm',
  [TransactionType.UNSTAKE_FARM]: 'unstake_farm',
  [TransactionType.CLAIM_FARM]: 'claim_farm'
}; 