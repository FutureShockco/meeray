export interface PoolCreateData {
  tokenA_symbol: string;      // Symbol of the first token in the pair
  tokenA_issuer: string;      // Issuer account of the first token
  tokenB_symbol: string;      // Symbol of the second token in the pair
  tokenB_issuer: string;      // Issuer account of the second token
  feeTier?: number;           // Optional: e.g., 5 (0.05%), 30 (0.3%), 100 (1%). In basis points.
  // poolId will be generated, including feeTier if provided
  // initialLiquidityTokenA: number; // Amount of token A to provide as initial liquidity - handled by AddLiquidity
  // initialLiquidityTokenB: number; // Amount of token B to provide as initial liquidity - handled by AddLiquidity
  // feeTier: number; // e.g., 0.003 for 0.3%, 0.01 for 1%. Could be predefined or user-selectable from a list.
  // For simplicity, let's assume a default fee for now, or manage it at a global config level.
  // creator: string; // Will be the transaction sender
}

export interface PoolAddLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  provider: string;           // Account providing the liquidity (sender of the transaction)
  tokenA_amount: number;      // Amount of token A to add
  tokenB_amount: number;      // Amount of token B to add (must respect pool ratio, or be first provider)
  // slippageProtection?: { maxTokenA?: number, maxTokenB?: number }; // Optional: Max amounts to guard against price changes.
}

export interface PoolRemoveLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  provider: string;           // Account removing the liquidity (sender of the transaction)
  lpTokenAmount: number;      // Amount of LP (Liquidity Provider) tokens to burn/redeem
  // minTokenA_amount?: number; // Optional: Minimum amount of token A expected back
  // minTokenB_amount?: number; // Optional: Minimum amount of token B expected back
}

export interface PoolSwapData {
  // Common fields for all swaps
  trader: string;             // Account performing the swap (sender of the transaction)
  amountIn: string;           // Amount of initial token to swap (as a string to preserve precision)
  minAmountOut: string;       // Minimum amount of final token expected (as a string, for slippage protection)

  // Fields for a direct, single-pool swap (becomes optional if 'hops' is present)
  poolId?: string;            // Identifier of the liquidity pool to swap through
  tokenInSymbol?: string;     // Symbol of the token being sold in a direct swap
  tokenInIssuer?: string;     // Issuer of the token being sold in a direct swap
  tokenOutSymbol?: string;    // Symbol of the token being bought in a direct swap
  tokenOutIssuer?: string;    // Issuer of the token being bought in a direct swap

  // Fields for a routed (multi-hop) swap (optional)
  // If 'hops' is provided, these define the overall start and end of the route
  fromTokenSymbol?: string;   // Overall input token symbol for the route (used if hops are present)
  fromTokenIssuer?: string;   // Overall input token issuer for the route
  toTokenSymbol?: string;     // Overall output token symbol for the route (used if hops are present)
  toTokenIssuer?: string;     // Overall output token issuer for the route
  hops?: Array<{
    poolId: string;          // ID of the liquidity pool for this specific hop
    // For clarity and validation, explicit in/out for each hop is good
    hopTokenInSymbol: string;
    hopTokenInIssuer: string;
    hopTokenOutSymbol: string;
    hopTokenOutIssuer: string;
  }>;
}

// Represents a liquidity pool in the cache/database
export interface LiquidityPool {
  _id: string;                // poolId: e.g., hash(tokenA_symbol-issuer, tokenB_symbol-issuer, feeTier) sorted alphabetically
  tokenA_symbol: string;
  tokenA_issuer: string;
  tokenA_reserve: number;     // Current balance of token A in the pool
  tokenB_symbol: string;
  tokenB_issuer: string;
  tokenB_reserve: number;     // Current balance of token B in the pool
  totalLpTokens: number;      // Total amount of LP tokens issued for this pool
  lpTokenSymbol: string;      // Generated LP token symbol, e.g., "LP_TOKENA_TOKENB"
  feeRate: number;            // Actual fee rate, e.g., 0.0005, 0.003, 0.01
  createdAt: string;          // ISO Date string
  lastUpdatedAt?: string;     // ISO Date string, added recently
  // transactions: string[];  // Optional: list of transaction IDs related to this pool
}

// Represents a user's share in a liquidity pool
export interface UserLiquidityPosition {
  _id: string;                // e.g., providerAddress-poolId
  provider: string;           // Account name of the liquidity provider
  poolId: string;
  lpTokenBalance: number;     // Amount of LP tokens held by this provider for this pool
  createdAt: string;          // ISO Date string when the position was first created
  lastUpdatedAt?: string;     // ISO Date string of the last update to this position
  // lastProvidedAt: string;  // This might be more specific than lastUpdatedAt if needed
  // lastWithdrawnAt?: string; // This might be more specific than lastUpdatedAt if needed
} 