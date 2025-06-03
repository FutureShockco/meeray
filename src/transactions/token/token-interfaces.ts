/**
 * Base token interfaces with BigInt values for application logic
 */
import { RecursiveBigIntToString } from '../../utils/bigint-utils.js'; // Assuming this is where RecursiveBigIntToString is

export interface TokenCreateData { // This is the INPUT to the transaction
  symbol: string;
  name: string;
  precision?: number;      // Defaults to 8 if not provided
  maxSupply: bigint;       // Will be string in DB
  initialSupply?: bigint;  // Optional, defaults to 0. Used to set currentSupply. Will be string in DB only for event log / input record if TokenCreateDataDB implies full stringify
  currentSupply?: bigint;  // Should not be part of create data, it's derived or for mint/burn. We'll set it from initialSupply for storage.
  mintable?: boolean;
  burnable?: boolean;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
  // issuer is added by the system, not part of direct input data typically
}

// Represents the actual document structure stored in the 'tokens' collection
export interface TokenForStorage {
  _id: string; // Typically the symbol
  symbol: string;
  name: string;
  precision: number;
  maxSupply: bigint;
  currentSupply: bigint;
  mintable: boolean;
  burnable: boolean;
  issuer: string;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
  createdAt: string; // Added for sorting new listings
  // Potentially other fields like updatedAt if managed by the system
}

export interface TokenMintData { // Input for minting
  symbol: string;
  to: string;
  amount: bigint;
}

export interface TokenTransferData { // Input for transferring
  symbol: string;
  to: string;
  amount: bigint;
  from?: string; // Added by the system (sender)
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
export type TokenCreateDataDB = RecursiveBigIntToString<TokenCreateData>;
export type TokenForStorageDB = RecursiveBigIntToString<TokenForStorage>;
export type TokenMintDataDB = RecursiveBigIntToString<TokenMintData>;
export type TokenTransferDataDB = RecursiveBigIntToString<TokenTransferData>; 