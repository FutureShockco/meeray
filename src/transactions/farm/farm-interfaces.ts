export interface FarmCreateData {
  lpTokenSymbol: string;      // Symbol of the LP token that will be staked (e.g., "TKA/TKB-LP")
  lpTokenIssuer: string;      // Issuer of the LP token
  rewardTokenSymbol: string;  // Symbol of the token given as reward
  rewardTokenIssuer: string;  // Issuer of the reward token
  // farmId will be generated, e.g., hash(lpTokenSymbol, lpTokenIssuer, rewardTokenSymbol, rewardTokenIssuer)
  // rewardRate: number; // Amount of rewardToken per second/block/period. This is complex and needs careful design for distribution.
  // startBlock/startTime: number; // Block or time when farming starts
  // endBlock/endTime: number;   // Block or time when farming ends (or if it's perpetual)
  // For simplicity, let's assume rewards are manually distributed or handled by a simpler periodic mechanism initially.
}

export interface FarmStakeData {
  farmId: string;             // Identifier of the farm
  staker: string;             // Account staking the LP tokens (sender)
  lpTokenAmount: number;      // Amount of LP tokens to stake
}

export interface FarmUnstakeData {
  farmId: string;             // Identifier of the farm
  staker: string;             // Account unstaking the LP tokens (sender)
  lpTokenAmount: number;      // Amount of LP tokens to unstake
  // withdrawRewards: boolean; // Default true, also claim pending rewards
}

export interface FarmClaimRewardsData {
  farmId: string;             // Identifier of the farm
  staker: string;             // Account claiming rewards (sender)
}

// Represents a Farm in the cache/database
export interface Farm {
  _id: string;                // farmId
  lpTokenSymbol: string;
  lpTokenIssuer: string;
  rewardTokenSymbol: string;
  rewardTokenIssuer: string;
  totalLpStaked: number;      // Total amount of LP tokens currently staked in this farm
  // rewardState: {
  //   lastDistributionTime: string; // ISO Date string or block number
  //   accumulatedRewardsPerShare: number; // For calculating individual rewards
  //   totalRewardsDistributed: number;
  // };
  // These reward mechanics are complex and will be added incrementally.
  createdAt: string;          // ISO Date string
}

// Represents a user's staking position in a Farm
export interface UserFarmPosition {
  _id: string;                // e.g., stakerAddress-farmId
  staker: string;
  farmId: string;
  stakedLpAmount: number;     // Amount of LP tokens staked by this user
  createdAt: string;          // ISO Date string when the position was first created
  lastStakedAt: string;       // ISO Date string of the last stake operation
  lastClaimedAt?: string;      // ISO Date string of the last reward claim
  // rewardDebt: number;        // Used in some reward calculation models (e.g., MasterChef)
} 