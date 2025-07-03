import { BigIntToString } from '../../utils/bigint-utils.js';

/**
 * Pool interfaces with BigInt values for application logic
 */

export interface PoolCreateData {
  tokenA_symbol: string;      // Symbol of the first token in the pair
  tokenB_symbol: string;      // Symbol of the second token in the pair
  feeTier?: number;           // Fee tier in basis points (e.g., 10 = 0.01%, 50 = 0.05%, 300 = 0.3%, 1000 = 1%)
  // poolId will be generated, including feeTier if provided
  // initialLiquidityTokenA: number; // Amount of token A to provide as initial liquidity - handled by AddLiquidity
  // initialLiquidityTokenB: number; // Amount of token B to provide as initial liquidity - handled by AddLiquidity
  // feeTier: number; // e.g., 0.003 for 0.3%, 0.01 for 1%. Could be predefined or user-selectable from a list.
  // For simplicity, let's assume a default fee for now, or manage it at a global config level.
  // creator: string; // Will be the transaction sender
}

export interface PoolAddLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  provider: string;           // Account providing the liquidity
  tokenA_amount: bigint;      // Amount of token A to add
  tokenB_amount: bigint;      // Amount of token B to add
}

export interface PoolRemoveLiquidityData {
  poolId: string;             // Identifier of the liquidity pool
  provider: string;           // Account removing the liquidity
  lpTokenAmount: bigint;      // Amount of LP tokens to burn
}

export interface PoolSwapData {
  // For single-hop swaps (backward compatible)
  poolId?: string;             // Identifier of the liquidity pool to swap through (for direct swap)
  tokenIn_symbol: string;     // Symbol of the token being swapped in
  tokenOut_symbol: string;    // Symbol of the token being swapped out
  amountIn: bigint;          // Amount of token being swapped in
  minAmountOut: bigint;      // Minimum amount of token to receive

  // For multi-hop routing (new functionality)
  fromTokenSymbol?: string;   // Overall input token symbol for a routed swap
  toTokenSymbol?: string;     // Overall output token symbol for a routed swap
  slippagePercent?: number;   // Slippage tolerance in percent (e.g., 1.0 for 1%)
  hops?: Array<{
    poolId: string;
    tokenIn_symbol: string;
    tokenOut_symbol: string;
    amountIn: bigint;
    minAmountOut: bigint;
  }>;
}

// Represents a liquidity pool in the cache/database
export interface LiquidityPool {
  _id: string;                // Pool identifier (usually tokenA_symbol-tokenB_symbol)
  tokenA_symbol: string;     // Symbol of token A
  tokenA_reserve: bigint;    // Current balance of token A in the pool
  tokenB_symbol: string;     // Symbol of token B
  tokenB_reserve: bigint;    // Current balance of token B in the pool
  totalLpTokens: bigint;     // Total amount of LP tokens issued for this pool
  feeTier: number;          // Fee tier in basis points (e.g., 10 = 0.01%, 50 = 0.05%, 300 = 0.3%, 1000 = 1%)
  createdAt: string;        // ISO date string
  lastTradeAt?: string;     // ISO date string of last trade
  status: string;           // Pool status (e.g., 'active', 'paused')

  // Fee accounting fields
  feeGrowthGlobalA?: bigint; // Cumulative fee per LP token for token A (scaled by 1e18)
  feeGrowthGlobalB?: bigint; // Cumulative fee per LP token for token B (scaled by 1e18)
}

// Represents a user's share in a liquidity pool
export interface UserLiquidityPosition {
  _id: string;                // e.g., providerAddress-poolId
  provider: string;           // Account name of the liquidity provider
  poolId: string;
  lpTokenBalance: bigint;     // Amount of LP tokens held by this provider for this pool
  createdAt: string;          // ISO Date string
  lastUpdatedAt?: string;     // ISO Date string

  // Fee accounting fields
  feeGrowthEntryA?: bigint; // User's last fee growth checkpoint for token A
  feeGrowthEntryB?: bigint; // User's last fee growth checkpoint for token B
  unclaimedFeesA?: bigint;  // Unclaimed fees in token A
  unclaimedFeesB?: bigint;  // Unclaimed fees in token B
}

/**
 * Database types (automatically converted from base types)
 */
export type PoolCreateDataDB = BigIntToString<PoolCreateData>;
export type PoolAddLiquidityDataDB = BigIntToString<PoolAddLiquidityData>;
export type PoolRemoveLiquidityDataDB = BigIntToString<PoolRemoveLiquidityData>;
export type PoolSwapDataDB = BigIntToString<PoolSwapData>;
export type LiquidityPoolDB = BigIntToString<LiquidityPool>;
export type UserLiquidityPositionDB = BigIntToString<UserLiquidityPosition>;