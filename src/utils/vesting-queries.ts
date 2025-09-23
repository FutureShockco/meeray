import cache from '../cache.js';
import { TokenDistributionRecipient, VestingState } from '../transactions/launchpad/launchpad-interfaces.js';
import { toBigInt } from './bigint.js';
import { calculateVestedAmount } from './vesting.js';

export interface VestingStatusResult {
    userId: string;
    launchpadId: string;
    allocationType: TokenDistributionRecipient;
    totalAllocated: bigint;
    totalClaimed: bigint;
    availableNow: bigint;
    stillLocked: bigint;
    nextVestingDate?: string;
    isFullyClaimed: boolean;
}

/**
 * Get vesting status for a user's allocation
 */
export async function getVestingStatus(
    userId: string,
    launchpadId: string,
    allocationType: TokenDistributionRecipient,
    currentTimestamp: string
): Promise<VestingStatusResult | null> {
    const vestingState = (await cache.findOnePromise('vesting_states', {
        userId,
        launchpadId,
        allocationType,
    })) as VestingState | null;

    if (!vestingState) {
        return null;
    }

    // Get launchpad and tokenomics to calculate vesting
    const launchpad = await cache.findOnePromise('launchpads', { _id: launchpadId });
    if (!launchpad || !launchpad.tokenomicsSnapshot?.allocations) {
        return null;
    }

    const allocation = launchpad.tokenomicsSnapshot.allocations.find((a: any) => a.recipient === allocationType);

    if (!allocation) {
        return null;
    }

    // Calculate current vesting status
    const vestingResult = calculateVestedAmount(
        allocation,
        toBigInt(vestingState.totalAllocated),
        vestingState.vestingStartTimestamp,
        currentTimestamp,
        toBigInt(vestingState.totalClaimed)
    );

    return {
        userId: vestingState.userId,
        launchpadId: vestingState.launchpadId,
        allocationType: vestingState.allocationType,
        totalAllocated: toBigInt(vestingState.totalAllocated),
        totalClaimed: toBigInt(vestingState.totalClaimed),
        availableNow: vestingResult.availableToClaim,
        stillLocked: vestingResult.stillLocked,
        nextVestingDate: vestingResult.nextVestingDate,
        isFullyClaimed: vestingState.isFullyClaimed,
    };
}

/**
 * Get all vesting states for a user across all launchpads
 */
export async function getUserVestingStates(userId: string, currentTimestamp: string): Promise<VestingStatusResult[]> {
    const vestingStates = (await cache.findPromise('vesting_states', { userId })) as VestingState[] | null;

    if (!vestingStates || vestingStates.length === 0) {
        return [];
    }

    const results: VestingStatusResult[] = [];

    for (const state of vestingStates) {
        const status = await getVestingStatus(state.userId, state.launchpadId, state.allocationType, currentTimestamp);

        if (status) {
            results.push(status);
        }
    }

    return results;
}

/**
 * Get all vesting states for a specific launchpad
 */
export async function getLaunchpadVestingStates(launchpadId: string, currentTimestamp: string): Promise<VestingStatusResult[]> {
    const vestingStates = (await cache.findPromise('vesting_states', { launchpadId })) as VestingState[] | null;

    if (!vestingStates || vestingStates.length === 0) {
        return [];
    }

    const results: VestingStatusResult[] = [];

    for (const state of vestingStates) {
        const status = await getVestingStatus(state.userId, state.launchpadId, state.allocationType, currentTimestamp);

        if (status) {
            results.push(status);
        }
    }

    return results;
}
