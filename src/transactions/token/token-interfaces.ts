export interface TokenCreateData {
  symbol: string;
  name: string;
  precision: number;
  maxSupply: number;
  initialSupply?: number;
  mintable?: boolean;
  burnable?: boolean; // Will be relevant for general token properties, even if burn is via transfer
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
}

export interface TokenMintData {
  symbol: string;
  to: string;
  amount: number;
}

export interface TokenTransferData {
  symbol: string;
  to: string;
  amount: number;
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