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
    FARM_UPDATE = 16,

    // Pool Transactions
    POOL_CREATE = 17,
    POOL_ADD_LIQUIDITY = 18,
    POOL_REMOVE_LIQUIDITY = 19,
    POOL_SWAP = 20,
    POOL_CLAIM_FEES = 21,

    // Token Transactions
    TOKEN_CREATE = 22,
    TOKEN_MINT = 23,
    TOKEN_TRANSFER = 24,
    TOKEN_UPDATE = 25,
    TOKEN_WITHDRAW = 26,

    // Witness Transactions
    WITNESS_REGISTER = 27,
    WITNESS_VOTE = 28,
    WITNESS_UNVOTE = 29,

    // Launchpad Transactions
    LAUNCHPAD_LAUNCH_TOKEN = 30,
    LAUNCHPAD_PARTICIPATE_PRESALE = 31,
    LAUNCHPAD_CLAIM_TOKENS = 32,

    // NEW NFT Auction/Bidding Transactions
    NFT_ACCEPT_BID = 33,
    NFT_CLOSE_AUCTION = 34,
    NFT_BATCH_OPERATIONS = 35,

    // Launchpad Lifecycle (Extended)
    LAUNCHPAD_UPDATE_STATUS = 36,
    LAUNCHPAD_FINALIZE_PRESALE = 37,
    LAUNCHPAD_SET_MAIN_TOKEN = 38,
    LAUNCHPAD_REFUND_PRESALE = 39,
    LAUNCHPAD_UPDATE_WHITELIST = 40,

    // NEW NFT Marketplace Transactions
    NFT_CANCEL_BID = 41,
    NFT_MAKE_OFFER = 42,
    NFT_ACCEPT_OFFER = 43,
    NFT_CANCEL_OFFER = 44,

    // Launchpad Configuration Transactions
    LAUNCHPAD_CONFIGURE_PRESALE = 45,
    LAUNCHPAD_CONFIGURE_TOKENOMICS = 46,
    LAUNCHPAD_CONFIGURE_AIRDROP = 47,
    LAUNCHPAD_UPDATE_METADATA = 48,
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
    [TransactionType.FARM_UPDATE]: 'farm_update',

    // Pool Transactions
    [TransactionType.POOL_CREATE]: 'pool_create',
    [TransactionType.POOL_ADD_LIQUIDITY]: 'pool_add_liquidity',
    [TransactionType.POOL_REMOVE_LIQUIDITY]: 'pool_remove_liquidity',
    [TransactionType.POOL_SWAP]: 'pool_swap',
    [TransactionType.POOL_CLAIM_FEES]: 'pool_claim_fees',

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

    // Launchpad Configuration Transactions
    [TransactionType.LAUNCHPAD_CONFIGURE_PRESALE]: 'launchpad_configure_presale',
    [TransactionType.LAUNCHPAD_CONFIGURE_TOKENOMICS]: 'launchpad_configure_tokenomics',
    [TransactionType.LAUNCHPAD_CONFIGURE_AIRDROP]: 'launchpad_configure_airdrop',
    [TransactionType.LAUNCHPAD_UPDATE_METADATA]: 'launchpad_update_metadata',

    // NEW NFT Marketplace Transactions
    [TransactionType.NFT_CANCEL_BID]: 'nft_cancel_bid',
    [TransactionType.NFT_MAKE_OFFER]: 'nft_make_offer',
    [TransactionType.NFT_ACCEPT_OFFER]: 'nft_accept_offer',
    [TransactionType.NFT_CANCEL_OFFER]: 'nft_cancel_offer',
};
