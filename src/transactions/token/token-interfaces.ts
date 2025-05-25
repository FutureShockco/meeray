/**
 * Base token interfaces with BigInt values for application logic
 */
export interface TokenCreateData {
  symbol: string;
  name: string;
  precision: number;
  maxSupply: bigint;        // Use bigint for internal operations
  initialSupply?: bigint;   // Use bigint for internal operations
  currentSupply?: bigint;   // Use bigint for internal operations
  mintable: boolean;
  burnable: boolean;        // Will be relevant for general token properties, even if burn is via transfer
  creator: string;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
}

export interface TokenMintData {
  symbol: string;
  to: string;
  amount: bigint;           // Use bigint for internal operations
}

export interface TokenTransferData {
  symbol: string;
  from: string;
  to: string;
  amount: bigint;           // Use bigint for internal operations
  memo?: string;
}

// No TokenBurnData as token-burn.ts will be removed

export interface TokenUpdateData {
  symbol: string;
  name?: string;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
}

/**
 * Type utilities for database conversions
 */
export type BigIntToString<T> = {
  [K in keyof T]: T[K] extends bigint ? string : T[K];
};

/**
 * Database types (automatically converted from base types)
 */
export type TokenCreateDataDB = BigIntToString<TokenCreateData>;
export type TokenMintDataDB = BigIntToString<TokenMintData>;
export type TokenTransferDataDB = BigIntToString<TokenTransferData>; 