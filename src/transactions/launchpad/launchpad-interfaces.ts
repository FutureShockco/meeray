export enum TokenStandard {
  NATIVE = 'NATIVE',
  WRAPPED_NATIVE_LIKE = 'WRAPPED_NATIVE_LIKE',
}

export enum VestingType {
  NONE = 'NONE',
  LINEAR_MONTHLY = 'LINEAR_MONTHLY',
  LINEAR_DAILY = 'LINEAR_DAILY',
  CLIFF = 'CLIFF',
  CUSTOM = 'CUSTOM',
}

export interface VestingSchedule {
  type: VestingType;
  cliffMonths?: number;
  durationMonths: number;
  initialUnlockPercentage?: number;
}

export enum TokenDistributionRecipient {
  PROJECT_TEAM = 'PROJECT_TEAM',
  ADVISORS = 'ADVISORS',
  MARKETING_OPERATIONS = 'MARKETING_OPERATIONS',
  ECOSYSTEM_DEVELOPMENT = 'ECOSYSTEM_DEVELOPMENT',
  LIQUIDITY_POOL = 'LIQUIDITY_POOL',
  PRESALE_PARTICIPANTS = 'PRESALE_PARTICIPANTS',
  PUBLIC_SALE = 'PUBLIC_SALE',
  AIRDROP_REWARDS = 'AIRDROP_REWARDS',
  TREASURY_RESERVE = 'TREASURY_RESERVE',
  STAKING_REWARDS = 'STAKING_REWARDS',
}

export interface TokenAllocation {
  recipient: TokenDistributionRecipient;
  percentage: number;
  vestingSchedule?: VestingSchedule;
  lockupMonths?: number;
  customRecipientAddress?: string;
}

export interface Tokenomics {
  totalSupply: number;
  tokenDecimals: number;
  allocations: TokenAllocation[];
}

export interface PresaleDetails {
  presaleTokenAllocationPercentage: number;
  pricePerToken: number;
  quoteAssetForPresaleSymbol: string;
  quoteAssetForPresaleIssuer?: string;
  minContributionPerUser: number;
  maxContributionPerUser: number;
  startTime: string;
  endTime: string;
  hardCap: number;
  softCap?: number;
  whitelistRequired?: boolean;
  fcfsAfterReservedAllocation?: boolean;
}

export interface LiquidityProvisionDetails {
  dexIdentifier: string;
  liquidityTokenAllocationPercentage: number;
  quoteAssetForLiquiditySymbol: string;
  quoteAssetForLiquidityIssuer?: string;
  initialQuoteAmountProvidedByProject?: number;
  lpTokenLockupMonths?: number;
}

export interface LaunchpadLaunchTokenData {
  userId: string;
  tokenName: string;
  tokenSymbol: string;
  tokenStandard: TokenStandard;
  tokenDescription?: string;
  tokenLogoUrl?: string;
  projectWebsite?: string;
  projectSocials?: { [platform: string]: string };
  tokenomics: Tokenomics;
  presaleDetails?: PresaleDetails;
  liquidityProvisionDetails?: LiquidityProvisionDetails;
  launchFeeTokenSymbol: string;
  launchFeeTokenIssuer?: string;
}

export enum LaunchpadStatus {
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UPCOMING = 'UPCOMING',
  PRESALE_SCHEDULED = 'PRESALE_SCHEDULED',
  PRESALE_ACTIVE = 'PRESALE_ACTIVE',
  PRESALE_PAUSED = 'PRESALE_PAUSED',
  PRESALE_ENDED = 'PRESALE_ENDED',
  PRESALE_SUCCEEDED_SOFTCAP_MET = 'PRESALE_SUCCEEDED_SOFTCAP_MET',
  PRESALE_SUCCEEDED_HARDCAP_MET = 'PRESALE_SUCCEEDED_HARDCAP_MET',
  PRESALE_FAILED_SOFTCAP_NOT_MET = 'PRESALE_FAILED_SOFTCAP_NOT_MET',
  TOKEN_GENERATION_EVENT = 'TOKEN_GENERATION_EVENT',
  LIQUIDITY_PROVISIONING = 'LIQUIDITY_PROVISIONING',
  TRADING_LIVE = 'TRADING_LIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface Token {
  _id: string;
  name: string;
  symbol: string;
  standard: TokenStandard;
  decimals: number;
  totalSupply: number;
  maxSupply?: number;
  owner: string;
  description?: string;
  logoUrl?: string;
  website?: string;
  socials?: { [platform: string]: string };
  createdAt: string;
  launchpadId: string;
}

export interface Launchpad {
  _id: string;
  projectId: string;
  status: LaunchpadStatus;
  tokenToLaunch: {
    name: string;
    symbol: string;
    standard: TokenStandard;
    decimals: number;
    totalSupply: number;
  };
  tokenomicsSnapshot: Tokenomics;
  presaleDetailsSnapshot?: PresaleDetails;
  liquidityProvisionDetailsSnapshot?: LiquidityProvisionDetails;
  launchedByUserId: string;
  createdAt: string;
  updatedAt: string;
  presale?: {
    startTimeActual?: string;
    endTimeActual?: string;
    totalQuoteRaised: number;
    participants: Array<{
      userId: string;
      quoteAmountContributed: number;
      tokensAllocated?: number;
      claimed: boolean;
    }>;
    status: 'NOT_STARTED' | 'ACTIVE' | 'ENDED_PENDING_CLAIMS' | 'ENDED_CLAIMS_PROCESSED' | 'FAILED';
  };
  mainTokenId?: string;
  dexPairAddress?: string;
  feePaid: boolean;
  feeDetails?: {
    tokenSymbol: string;
    tokenIssuer?: string;
    amount: number;
  };
  relatedTxIds?: string[];
}

export interface LaunchpadParticipatePresaleData {
  userId: string;
  launchpadId: string;
  contributionAmount: number;
}

export interface LaunchpadClaimTokensData {
  userId: string;
  launchpadId: string;
  allocationType: TokenDistributionRecipient;
} 