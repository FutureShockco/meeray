export enum VestingType {
  NONE = 'NONE',
  LINEAR_MONTHLY = 'LINEAR_MONTHLY',
  LINEAR_DAILY = 'LINEAR_DAILY',
  CLIFF = 'CLIFF'
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
  totalSupply: string | bigint;        // Total token supply
  tokenDecimals: number;      // Number of decimal places (0-18)
  allocations: TokenAllocation[];
}

export interface PresaleDetails {
  presaleTokenAllocationPercentage: number;
  pricePerToken: string | bigint;
  quoteAssetForPresaleSymbol: string;
  minContributionPerUser: string | bigint;
  maxContributionPerUser: string | bigint;
  startTime: string;
  endTime: string;
  hardCap: string | bigint;
  softCap?: string | bigint;
  whitelistRequired?: boolean;
  fcfsAfterReservedAllocation?: boolean;
}

export interface LaunchpadLaunchTokenData {
  userId: string;
  tokenName: string;
  tokenSymbol: string;
  totalSupply: string | bigint;
  tokenDecimals?: number; // defaults to 18
  
  // Optional basic info (can also be set via LaunchpadUpdateMetadataData)
  tokenDescription?: string;
  projectWebsite?: string;
  
  // Fee payment (required)
  launchFeeTokenSymbol: string;
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
  TRADING_LIVE = 'TRADING_LIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface TokenData {
  _id: string;
  name: string;
  symbol: string;
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

export interface LaunchpadData {
  _id: string;
  projectId: string;
  status: LaunchpadStatus;
  tokenToLaunch: {
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string | bigint;
  };
  tokenomicsSnapshot?: Tokenomics; // Optional - can be configured later
  presaleDetailsSnapshot?: PresaleDetails;
  airdropRecipients?: Array<{
    username: string;
    amount: string | bigint;
    claimed: boolean;
  }>;
  launchedByUserId: string;
  createdAt: string;
  updatedAt: string;
  presale?: {
    startTimeActual?: string;
    endTimeActual?: string;
    totalQuoteRaised: string | bigint;
    participants: Array<{
      userId: string;
      quoteAmountContributed: string | bigint;
      tokensAllocated?: string | bigint;
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
    amount: string | bigint;
  };
  relatedTxIds?: string[];
}

export interface LaunchpadParticipatePresaleData {
  userId: string;
  launchpadId: string;
  contributionAmount: string | bigint;
}

export interface LaunchpadClaimTokensData {
  userId: string;
  launchpadId: string;
  allocationType: TokenDistributionRecipient;
}

// Additional configuration transactions
export interface LaunchpadConfigurePresaleData {
  userId: string;
  launchpadId: string;
  presaleDetails: PresaleDetails;
}

export interface LaunchpadConfigureTokenomicsData {
  userId: string;
  launchpadId: string;
  tokenomics: Tokenomics;
}

export interface LaunchpadUpdateMetadataData {
  userId: string;
  launchpadId: string;
  tokenDescription?: string;
  tokenLogoUrl?: string;
  projectSocials?: { [platform: string]: string };
}

export interface AirdropRecipient {
  username: string;
  amount: string | bigint;
}

export interface LaunchpadConfigureAirdropData {
  userId: string;
  launchpadId: string;
  recipients: AirdropRecipient[];
}

export interface VestingState {
  userId: string;
  launchpadId: string;
  allocationType: TokenDistributionRecipient;
  totalAllocated: string | bigint;
  totalClaimed: string | bigint;
  vestingStartTimestamp: string; // Steem block timestamp when vesting started
  lastClaimedTimestamp?: string;
  isFullyClaimed: boolean;
}
