import { getTokenDecimals } from './bigint.js';

/**
 * Calculate fee growth delta for a swap, normalized to 18 decimals for fair LP distribution.
 * @param feeAmount Fee amount in token's smallest units (BigInt)
 * @param tokenSymbol The symbol of the token the fee is in
 * @param totalLpTokens Total LP tokens (in 1e18 units, BigInt)
 * @returns Fee growth delta (BigInt, 1e18 units)
 */
export function calculateFeeGrowthDelta(feeAmount: bigint, tokenSymbol: string, totalLpTokens: bigint): bigint {
    if (totalLpTokens <= 0n || feeAmount <= 0n) return 0n;
    const tokenDecimals = getTokenDecimals(tokenSymbol);
    const scaleFactor = 10n ** BigInt(18 - tokenDecimals);
    const normalizedFeeAmount = feeAmount * scaleFactor;
    // feeGrowthDelta = (normalizedFeeAmount * 1e18) / totalLpTokens
    return (normalizedFeeAmount * 1_000_000_000_000_000_000n) / totalLpTokens;
}
