// Farm interfaces with string | bigint for all numeric fields

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
    startTime: string; // ISO date string
    endTime: string; // ISO date string
    totalRewards: string | bigint; // Total rewards to be distributed
    rewardsPerBlock: string | bigint; // Rewards distributed per block
    minStakeAmount?: string | bigint; // Minimum amount that can be staked
    maxStakeAmount?: string | bigint; // Maximum amount that can be staked per user
    weight?: number; // Farm weight for native reward distribution (default: 1)
}

export interface FarmStakeData {
    farmId: string;
    staker: string;
    lpTokenAmount: string | bigint; // Amount of LP tokens to stake
}

export interface FarmUnstakeData {
    farmId: string;
    staker: string;
    lpTokenAmount: string | bigint; // Amount of LP tokens to unstake
}

export interface FarmClaimRewardsData {
    farmId: string;
}

export interface FarmData extends FarmCreateData {
    _id: string; // Unique farm ID
    totalStaked: string | bigint; // Total amount of staking tokens deposited
    minStakeAmount: string | bigint; // Minimum amount that can be staked
    maxStakeAmount: string | bigint; // Maximum amount that can be staked per user
    weight: number; // Farm weight for native reward distribution
    isNativeFarm: boolean; // True if this farm gets native MRY rewards from the global pool
    isActive?: boolean; // Farm active status (default: true)
    status: 'active' | 'ended' | 'cancelled';
    createdAt: string;
    lastUpdatedAt?: string;
    lastRewardUpdate?: string; // Last time rewards were updated
    // Optional fields for runtime accounting
    rewardsRemaining?: string | bigint;
    vaultAccount?: string;
}

export interface UserFarmPositionData {
    _id: string; // userId-farmId
    userId: string;
    farmId: string;
    stakedAmount: string | bigint; // Current staked amount
    pendingRewards: string | bigint; // Unclaimed rewards
    lastHarvestTime: string; // ISO date string of last reward claim
    createdAt: string;
    lastUpdatedAt?: string;
}
