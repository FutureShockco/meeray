// Farm interfaces with string | bigint for all numeric fields

export interface FarmCreateData {
    farmId: string;
    stakingToken: string;
    rewardToken: string;
    startBlock: number;
    totalRewards: string | bigint;
    rewardsPerBlock: string | bigint;
    minStakeAmount?: string | bigint;
    maxStakeAmount?: string | bigint;
    weight?: number;
}

export interface FarmStakeData {
    farmId: string;
    tokenAmount: string | bigint;
}

export interface FarmUnstakeData {
    farmId: string;
    tokenAmount: string | bigint;
}

export interface FarmClaimRewardsData {
    farmId: string;
}

export interface FarmData extends FarmCreateData {
    _id: string;
    totalStaked: string | bigint; // Total amount of staking tokens deposited
    minStakeAmount: string | bigint; // Minimum amount that can be staked
    maxStakeAmount: string | bigint; // Maximum amount that can be staked per user
    weight: number; // Farm weight for native reward distribution
    isNativeFarm: boolean; // True if this farm distributes native MRY rewards from the global pool
    status: 'active' | 'ended' | 'cancelled' | 'paused';
    createdAt: string;
    lastUpdatedBlock?: number;
    isAuto: boolean; // True if the reward token is mintable and totalRewards is undefined
    rewardBalance?: string | bigint;
    creator: string; // Account that created the farm
}

export interface UserFarmPositionData {
    _id: string;
    userId: string;
    farmId: string;
    stakedAmount: string | bigint;
    pendingRewards: string | bigint;
    lastHarvestBlock: number;
    lastUpdatedAt: string;
    createdAt: string;
}

export interface FarmUpdateData {
    farmId: string;
    newWeight?: number;
    newStatus?: 'active' | 'paused' | 'cancelled';
    updatedAt?: string; // ISO timestamp, optional
    reason?: string; // Optional reason for update
}