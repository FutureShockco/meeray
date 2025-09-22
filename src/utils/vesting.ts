import { VestingSchedule, VestingType, TokenAllocation } from '../transactions/launchpad/launchpad-interfaces.js';
import { toBigInt } from './bigint.js';

export interface VestingCalculationResult {
  totalVested: bigint;        // Total amount that should be vested by now
  availableToClaim: bigint;   // Amount available to claim (total vested - already claimed)
  stillLocked: bigint;        // Amount still locked
  nextVestingDate?: string;   // When next tokens will vest (if applicable)
}

/**
 * Calculate vested tokens based on Steem block timestamps
 */
export function calculateVestedAmount(
  allocation: TokenAllocation,
  totalAllocatedTokens: bigint,
  vestingStartTimestamp: string,
  currentTimestamp: string,
  alreadyClaimed: bigint = BigInt(0)
): VestingCalculationResult {
  
  if (!allocation.vestingSchedule || allocation.vestingSchedule.type === VestingType.NONE) {
    // No vesting - all tokens available immediately
    return {
      totalVested: totalAllocatedTokens,
      availableToClaim: totalAllocatedTokens - alreadyClaimed,
      stillLocked: BigInt(0)
    };
  }

  const vestingSchedule = allocation.vestingSchedule;
  const startTime = new Date(vestingStartTimestamp).getTime();
  const currentTime = new Date(currentTimestamp).getTime();
  const timeElapsedMs = currentTime - startTime;
  const timeElapsedMonths = timeElapsedMs / (1000 * 60 * 60 * 24 * 30.44); // Average month

  // Handle cliff period
  const cliffMonths = vestingSchedule.cliffMonths || 0;
  if (timeElapsedMonths < cliffMonths) {
    // Still in cliff period - only initial unlock available
    const initialUnlockPercent = vestingSchedule.initialUnlockPercentage || 0;
    const initialUnlockAmount = (totalAllocatedTokens * BigInt(initialUnlockPercent)) / BigInt(100);
    
    return {
      totalVested: initialUnlockAmount,
      availableToClaim: initialUnlockAmount - alreadyClaimed,
      stillLocked: totalAllocatedTokens - initialUnlockAmount,
      nextVestingDate: new Date(startTime + (cliffMonths * 30.44 * 24 * 60 * 60 * 1000)).toISOString()
    };
  }

  // Calculate vesting based on type
  let vestedAmount = BigInt(0);
  const initialUnlockPercent = vestingSchedule.initialUnlockPercentage || 0;
  const initialUnlockAmount = (totalAllocatedTokens * BigInt(initialUnlockPercent)) / BigInt(100);
  const vestingAmount = totalAllocatedTokens - initialUnlockAmount;

  switch (vestingSchedule.type) {
    case VestingType.LINEAR_MONTHLY: {
      const vestingMonths = vestingSchedule.durationMonths;
      const monthsVested = Math.min(timeElapsedMonths - cliffMonths, vestingMonths);
      const vestingProgress = monthsVested / vestingMonths;
      vestedAmount = initialUnlockAmount + (vestingAmount * BigInt(Math.floor(vestingProgress * 10000))) / BigInt(10000);
      break;
    }
    
    case VestingType.LINEAR_DAILY: {
      const vestingDays = vestingSchedule.durationMonths * 30.44;
      const timeElapsedDays = timeElapsedMs / (1000 * 60 * 60 * 24);
      const daysVested = Math.min(timeElapsedDays - (cliffMonths * 30.44), vestingDays);
      const vestingProgress = daysVested / vestingDays;
      vestedAmount = initialUnlockAmount + (vestingAmount * BigInt(Math.floor(vestingProgress * 10000))) / BigInt(10000);
      break;
    }
    
    case VestingType.CLIFF: {
      // Cliff type: all tokens unlock after cliff period + duration
      const totalLockMonths = cliffMonths + vestingSchedule.durationMonths;
      if (timeElapsedMonths >= totalLockMonths) {
        vestedAmount = totalAllocatedTokens;
      } else {
        vestedAmount = initialUnlockAmount;
      }
      break;
    }
      
    default:
      vestedAmount = initialUnlockAmount;
  }

  // Ensure we don't exceed total allocation
  vestedAmount = vestedAmount > totalAllocatedTokens ? totalAllocatedTokens : vestedAmount;
  
  return {
    totalVested: vestedAmount,
    availableToClaim: vestedAmount - alreadyClaimed,
    stillLocked: totalAllocatedTokens - vestedAmount
  };
}

/**
 * Calculate tokens allocated to a specific user for an allocation type
 */
export function calculateUserAllocation(
  allocation: TokenAllocation,
  totalTokenSupply: bigint,
  userShare?: bigint, // For presale participants based on contribution
  totalShares?: bigint // Total contributions for presale
): bigint {
  const allocationAmount = (totalTokenSupply * BigInt(allocation.percentage)) / BigInt(100);
  
  if (allocation.recipient === 'PRESALE_PARTICIPANTS' && userShare && totalShares && totalShares > BigInt(0)) {
    // Calculate proportional share for presale participant
    return (allocationAmount * userShare) / totalShares;
  }
  
  // For other allocations (team, advisors, etc.), return full allocation
  // In practice, you'd need logic to determine who gets what portion
  return allocationAmount;
}

/**
 * Parse Steem timestamp to ISO string
 */
export function parseSteemTimestamp(steemTimestamp: string): string {
  // Steem timestamps are usually in format: "2025-09-10T12:34:56"
  // Ensure it's a valid ISO string
  if (steemTimestamp.includes('T') && !steemTimestamp.endsWith('Z')) {
    return steemTimestamp + 'Z'; // Add Z for UTC
  }
  return steemTimestamp;
}