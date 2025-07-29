
export interface TokenData {
  _id?: string;
  symbol: string;
  name: string;
  precision?: number;
  maxSupply: string | bigint; // Use string for large values
  initialSupply?: string | bigint; // Use string for large values
  currentSupply?: string | bigint; // Use string for large values
  mintable?: boolean;
  burnable?: boolean;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
  issuer?: string;
  createdAt?: string;
}

export interface TokenMintData {
  symbol: string;
  to: string;
  amount: bigint;
}

export interface TokenTransferData {
  symbol: string;
  to: string;
  amount: bigint;
  from?: string;
  memo?: string;
}


export interface TokenUpdateData {
  symbol: string;
  name?: string;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
}