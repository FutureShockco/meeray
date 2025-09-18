import { toBigInt } from './bigint.js';

/**
 * Calculates the output amount for a swap using the constant product formula
 * This is used across pool swaps and market trades for consistency
 * 
 * @param inputAmount - Amount of input tokens
 * @param inputReserve - Reserve of input token in the pool
 * @param outputReserve - Reserve of output token in the pool
 * @returns Expected output amount after fees
 */
export function getOutputAmountBigInt(
    inputAmount: bigint,
    inputReserve: bigint,
    outputReserve: bigint
): bigint {
    if (inputAmount <= 0n || inputReserve <= 0n || outputReserve <= 0n) {
        return 0n;
    }

    // Use fixed 0.3% fee tier (300 basis points)
    const feeMultiplier = BigInt(9700); // 10000 - 300 = 9700 for 0.3% fee
    const feeDivisor = BigInt(10000);

    const amountInAfterFee = (inputAmount * feeMultiplier) / feeDivisor;

    if (amountInAfterFee <= 0n) return 0n;

    const numerator = amountInAfterFee * outputReserve;
    const denominator = inputReserve + amountInAfterFee;
    
    if (denominator === 0n) return 0n;
    return numerator / denominator;
}

/**
 * Helper function to calculate expected AMM output with token direction logic
 * 
 * @param inputAmount - Amount of input tokens
 * @param tokenIn - Symbol of input token
 * @param tokenOut - Symbol of output token
 * @param ammSource - AMM liquidity source with reserve data
 * @returns Expected output amount
 */
export function calculateExpectedAMMOutput(
    inputAmount: bigint,
    tokenIn: string,
    tokenOut: string,
    ammSource: { tokenA: string, tokenB: string, reserveA?: string | bigint, reserveB?: string | bigint }
): bigint {
    const reserveA = toBigInt(ammSource.reserveA || '0');
    const reserveB = toBigInt(ammSource.reserveB || '0');
    const tokenInIsA = tokenIn === ammSource.tokenA;
    
    const inputReserve = tokenInIsA ? reserveA : reserveB;
    const outputReserve = tokenInIsA ? reserveB : reserveA;
    
    return getOutputAmountBigInt(inputAmount, inputReserve, outputReserve);
}

/**
 * Calculates the price impact of a swap
 * 
 * @param amountIn - Input amount
 * @param reserveIn - Input token reserve
 * @returns Price impact as a percentage (0-100)
 */
export function calculatePriceImpact(amountIn: bigint, reserveIn: bigint): number {
    if (reserveIn === 0n || amountIn === 0n) return 0;
    
    const impact = Number(amountIn) / Number(reserveIn);
    return Math.min(impact * 100, 100); // Cap at 100%
}
