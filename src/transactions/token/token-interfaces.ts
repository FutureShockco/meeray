
export interface TokenData {
  _id?: string;
  symbol: string;
  name: string;
  precision: number;
  maxSupply: string | bigint;
  initialSupply?: string | bigint;
  currentSupply?: string | bigint;
  mintable?: boolean;
  burnable?: boolean;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
  issuer?: string;
  createdAt?: string;
}

export interface TokenTransferData {
  symbol: string;
  to: string;
  amount: string | bigint;
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