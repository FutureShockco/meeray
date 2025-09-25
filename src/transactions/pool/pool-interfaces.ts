// Pool interfaces with string | bigint for all numeric fields

// Swap result interface
export interface PoolSwapResult {
    success: boolean;
    amountOut: bigint;
    error?: string;
}

export interface PoolData {
    tokenA_symbol: string; // Symbol of the first token in the pair
    tokenB_symbol: string; // Symbol of the second token in the pair
}

export interface PoolAddLiquidityData {
    poolId: string; // Identifier of the liquidity pool
    tokenA_amount: string | bigint; // Amount of token A to add
    tokenB_amount: string | bigint; // Amount of token B to add
}

export interface PoolRemoveLiquidityData {
    poolId: string; // Identifier of the liquidity pool
    lpTokenAmount: string | bigint; // Amount of LP tokens to burn
}

export interface PoolSwapData {
    // For single-hop swaps (backward compatible)
    poolId?: string; // Identifier of the liquidity pool to swap through (for direct swap)
    tokenIn_symbol: string; // Symbol of the token being swapped in
    tokenOut_symbol: string; // Symbol of the token being swapped out
    amountIn: string | bigint; // Amount of token being swapped in
    minAmountOut: string | bigint; // Minimum amount of token to receive

    // For multi-hop routing (new functionality)
    fromTokenSymbol?: string; // Overall input token symbol for a routed swap
    toTokenSymbol?: string; // Overall output token symbol for a routed swap
    slippagePercent?: number; // Slippage tolerance in percent (e.g., 1.0 for 1%)
    hops?: Array<{
        poolId: string;
        tokenIn_symbol: string;
        tokenOut_symbol: string;
        amountIn: string | bigint;
        minAmountOut: string | bigint;
    }>;
}

export interface LiquidityPoolData {
    _id: string;
    tokenA_symbol: string;
    tokenA_reserve: string | bigint;
    tokenB_symbol: string;
    tokenB_reserve: string | bigint;
    totalLpTokens: string | bigint;
    createdAt: string;
    lastTradeAt?: string;
    status: string;
    feeGrowthGlobalA?: string | bigint;
    feeGrowthGlobalB?: string | bigint;
}

// Represents a user's share in a liquidity pool
export interface UserLiquidityPositionData {
    _id: string; // e.g., userAccount-poolId
    user: string; // Account name of the liquidity provider
    poolId: string;
    lpTokenBalance: string | bigint; // Amount of LP tokens held by this user for this pool
    createdAt: string; // ISO Date string
    lastUpdatedAt?: string; // ISO Date string

    // Fee accounting fields
    feeGrowthEntryA?: string | bigint; // User's last fee growth checkpoint for token A
    feeGrowthEntryB?: string | bigint; // User's last fee growth checkpoint for token B
    unclaimedFeesA?: string | bigint; // Unclaimed fees in token A
    unclaimedFeesB?: string | bigint; // Unclaimed fees in token B
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
