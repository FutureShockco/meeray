// Pool interfaces with string | bigint for all numeric fields

// Swap result interface
export interface PoolSwapResult {
  success: boolean;
  amountOut: bigint;
  error?: string;
}

export interface PoolData {
  tokenA_symbol: string;      // Symbol of the first token in the pair
  tokenB_symbol: string;      // Symbol of the second token in the pair
}

export interface PoolAddLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  tokenA_amount: string | bigint;      // Amount of token A to add
  tokenB_amount: string | bigint;      // Amount of token B to add
}

export interface PoolRemoveLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  lpTokenAmount: string | bigint;      // Amount of LP tokens to burn
}

export interface PoolSwapData {
  // For single-hop swaps (backward compatible)
  poolId?: string;             // Identifier of the liquidity pool to swap through (for direct swap)
  tokenIn_symbol: string;     // Symbol of the token being swapped in
  tokenOut_symbol: string;    // Symbol of the token being swapped out
  amountIn: string | bigint;          // Amount of token being swapped in
  minAmountOut: string | bigint;      // Minimum amount of token to receive

  // For multi-hop routing (new functionality)
  fromTokenSymbol?: string;   // Overall input token symbol for a routed swap
  toTokenSymbol?: string;     // Overall output token symbol for a routed swap
  slippagePercent?: number;   // Slippage tolerance in percent (e.g., 1.0 for 1%)
  hops?: Array<{
    poolId: string;
    tokenIn_symbol: string;
    tokenOut_symbol: string;
    amountIn: string | bigint;
    minAmountOut: string | bigint;
  }>;
}

// Represents a liquidity pool in the cache/database
export interface LiquidityPoolData {
  _id: string;                // Pool identifier (tokenA_symbol-tokenB_symbol)
  tokenA_symbol: string;     // Symbol of token A
  tokenA_reserve: string | bigint;    // Current balance of token A in the pool
  tokenB_symbol: string;     // Symbol of token B
  tokenB_reserve: string | bigint;    // Current balance of token B in the pool
  totalLpTokens: string | bigint;     // Total amount of LP tokens issued for this pool
  createdAt: string;        // ISO date string
  lastTradeAt?: string;     // ISO date string of last trade
  status: string;           // Pool status (e.g., 'active', 'paused')
  // Note: Fee is fixed at 0.3% (300 basis points) - no longer stored per pool

  // Fee accounting fields
  feeGrowthGlobalA?: string | bigint; // Cumulative fee per LP token for token A (scaled by 1e18)
  feeGrowthGlobalB?: string | bigint; // Cumulative fee per LP token for token B (scaled by 1e18)
}

// Represents a user's share in a liquidity pool
export interface UserLiquidityPositionData {
  _id: string;                // e.g., userAccount-poolId
  user: string;               // Account name of the liquidity provider
  poolId: string;
  lpTokenBalance: string | bigint;     // Amount of LP tokens held by this user for this pool
  createdAt: string;          // ISO Date string
  lastUpdatedAt?: string;     // ISO Date string

  // Fee accounting fields
  feeGrowthEntryA?: string | bigint; // User's last fee growth checkpoint for token A
  feeGrowthEntryB?: string | bigint; // User's last fee growth checkpoint for token B
  unclaimedFeesA?: string | bigint;  // Unclaimed fees in token A
  unclaimedFeesB?: string | bigint;  // Unclaimed fees in token B
}

export interface TradeHop {
    poolId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    priceImpact: number;
}

export interface TradeRoute {
    hops: TradeHop[];
    finalAmountIn: string;
    finalAmountOut: string;
}

export interface Pool {
    _id: string;
    tokenA_symbol: string;
    tokenA_reserve: string;
    tokenB_symbol: string;
    tokenB_reserve: string;
}