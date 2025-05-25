import { BigIntToString } from '../../utils/bigint-utils.js';

/**
 * Pool interfaces with BigInt values for application logic
 */

export interface PoolCreateData {
  tokenA_symbol: string;      // Symbol of the first token in the pair
  tokenA_issuer: string;      // Issuer account of the first token
  tokenB_symbol: string;      // Symbol of the second token in the pair
  tokenB_issuer: string;      // Issuer account of the second token
  feeTier?: bigint;           // Fee tier in basis points (e.g., 5 = 0.05%, 30 = 0.3%, 100 = 1%)
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
  poolId: string;             // Identifier of the liquidity pool
  trader: string;             // Account performing the swap
  tokenIn_symbol: string;     // Symbol of token being swapped in
  tokenOut_symbol: string;    // Symbol of token being swapped out
  amountIn: bigint;          // Amount of token being swapped in
  minAmountOut: bigint;      // Minimum amount of token to receive
}

// Represents a liquidity pool in the cache/database
export interface LiquidityPool {
  _id: string;                // Pool identifier (usually tokenA_symbol-tokenB_symbol)
  tokenA_symbol: string;     // Symbol of token A
  tokenA_issuer: string;     // Issuer account of token A
  tokenA_reserve: bigint;    // Current balance of token A in the pool
  tokenB_symbol: string;     // Symbol of token B
  tokenB_issuer: string;     // Issuer account of token B
  tokenB_reserve: bigint;    // Current balance of token B in the pool
  totalLpTokens: bigint;     // Total amount of LP tokens issued for this pool
  feeTier: bigint;          // Fee tier in basis points (e.g., 30 = 0.3%)
  createdAt: string;        // ISO date string
  lastTradeAt?: string;     // ISO date string of last trade
  status: string;           // Pool status (e.g., 'active', 'paused')
}

// Represents a user's share in a liquidity pool
export interface UserLiquidityPosition {
  _id: string;                // e.g., providerAddress-poolId
  provider: string;           // Account name of the liquidity provider
  poolId: string;
  lpTokenBalance: bigint;     // Amount of LP tokens held by this provider for this pool
  createdAt: string;          // ISO Date string
  lastUpdatedAt?: string;     // ISO Date string
  // lastProvidedAt: string;  // This might be more specific than lastUpdatedAt if needed
  // lastWithdrawnAt?: string; // This might be more specific than lastUpdatedAt if needed
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