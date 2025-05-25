import { BigIntToString } from '../../utils/bigint-utils.js';

/**
 * Farm interfaces with BigInt values for application logic
 */

export interface FarmCreateData {
  farmId: string;
  name: string;
  stakingToken: {
    symbol: string;
    issuer: string;
  };
  rewardToken: {
    symbol: string;
    issuer: string;
  };
  startTime: string;          // ISO date string
  endTime: string;           // ISO date string
  totalRewards: bigint;      // Total rewards to be distributed
  rewardsPerBlock: bigint;   // Rewards distributed per block
  minStakeAmount?: bigint;   // Minimum amount that can be staked
  maxStakeAmount?: bigint;   // Maximum amount that can be staked per user
}

export interface FarmStakeData {
  farmId: string;
  staker: string;
  lpTokenAmount: bigint;     // Amount of LP tokens to stake
}

export interface FarmUnstakeData {
  farmId: string;
  staker: string;
  lpTokenAmount: bigint;     // Amount of LP tokens to unstake
}

export interface FarmClaimRewardsData {
  farmId: string;
  staker: string;
}

export interface Farm {
  _id: string;               // Unique farm ID
  name: string;
  stakingToken: {
    symbol: string;
    issuer: string;
  };
  rewardToken: {
    symbol: string;
    issuer: string;
  };
  startTime: string;         // ISO date string
  endTime: string;          // ISO date string
  totalRewards: bigint;     // Total rewards to be distributed
  rewardsPerBlock: bigint;  // Rewards distributed per block
  totalStaked: bigint;      // Total amount of staking tokens deposited
  minStakeAmount: bigint;   // Minimum amount that can be staked
  maxStakeAmount: bigint;   // Maximum amount that can be staked per user
  status: 'active' | 'ended' | 'cancelled';
  createdAt: string;
  lastUpdatedAt?: string;
}

export interface UserFarmPosition {
  _id: string;              // userId-farmId
  userId: string;
  farmId: string;
  stakedAmount: bigint;     // Current staked amount
  pendingRewards: bigint;   // Unclaimed rewards
  lastHarvestTime: string;  // ISO date string of last reward claim
  createdAt: string;
  lastUpdatedAt?: string;
}

/**
 * Database types (automatically converted from base types)
 */
export type FarmCreateDataDB = BigIntToString<FarmCreateData>;
export type FarmStakeDataDB = BigIntToString<FarmStakeData>;
export type FarmUnstakeDataDB = BigIntToString<FarmUnstakeData>;
export type FarmDB = BigIntToString<Farm>;
export type UserFarmPositionDB = BigIntToString<UserFarmPosition>; 