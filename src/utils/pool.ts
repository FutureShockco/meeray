import cache from '../cache.js';
import { LiquidityPoolData, Pool, TradeHop, TradeRoute } from '../transactions/pool/pool-interfaces.js';
import { sqrt, toBigInt, getTokenDecimals } from './bigint.js';

/**
 * Generates a pool ID from token symbols
 * This is used across pool swaps and market trades for consistency
 * 
 * @param tokenA_symbol - Symbol of token A
 * @param tokenB_symbol - Symbol of token B
 * @returns Pool ID
 */
export function generatePoolId(tokenA_symbol: string, tokenB_symbol: string): string {
    const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
    return `${token1}_${token2}`;
}

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
    const feeMultiplier = toBigInt(9700); // 10000 - 300 = 9700 for 0.3% fee
    const feeDivisor = toBigInt(10000);

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

/**
 * Finds the best trade route from start token to end token
 */
export async function findBestTradeRoute(
    startTokenSymbol: string,
    endTokenSymbol: string,
    initialAmountIn: bigint,
    maxHops: number = 3
): Promise<TradeRoute | null> {
    const allPoolsFromDB: any[] = await cache.findPromise('liquidityPools', {}) || [];
    const allPools: Pool[] = allPoolsFromDB.map(p => ({
        _id: p._id.toString(),
        tokenA_symbol: p.tokenA_symbol,
        tokenA_reserve: p.tokenA_reserve,
        tokenB_symbol: p.tokenB_symbol,
        tokenB_reserve: p.tokenB_reserve
    }));

    const routes: TradeRoute[] = [];
    const queue: [string, TradeHop[], bigint][] = [[startTokenSymbol, [], initialAmountIn]];

    while (queue.length > 0) {
        const [currentTokenSymbol, currentPath, currentAmountIn] = queue.shift()!;
        if (currentPath.length >= maxHops) continue;

        for (const pool of allPools) {
            let tokenInReserveStr: string, tokenOutReserveStr: string, nextTokenSymbol: string;

            if (pool.tokenA_symbol === currentTokenSymbol) {
                tokenInReserveStr = pool.tokenA_reserve;
                tokenOutReserveStr = pool.tokenB_reserve;
                nextTokenSymbol = pool.tokenB_symbol;
            } else if (pool.tokenB_symbol === currentTokenSymbol) {
                tokenInReserveStr = pool.tokenB_reserve;
                tokenOutReserveStr = pool.tokenA_reserve;
                nextTokenSymbol = pool.tokenA_symbol;
            } else {
                continue;
            }

            const tokenInReserve = toBigInt(tokenInReserveStr);
            const tokenOutReserve = toBigInt(tokenOutReserveStr);
            if (tokenInReserve <= 0n || tokenOutReserve <= 0n) continue;
            if (currentPath.length > 0 && currentPath[currentPath.length - 1].tokenIn === nextTokenSymbol) continue;

            const amountOutFromHop = getOutputAmountBigInt(currentAmountIn, tokenInReserve, tokenOutReserve);
            if (amountOutFromHop <= 0n) continue;

            const priceImpact = calculatePriceImpact(currentAmountIn, tokenInReserve);

            const newHop: TradeHop = {
                poolId: pool._id,
                tokenIn: currentTokenSymbol,
                tokenOut: nextTokenSymbol,
                amountIn: currentAmountIn.toString(),
                amountOut: amountOutFromHop.toString(),
                priceImpact: priceImpact
            };
            const newPath = [...currentPath, newHop];

            if (nextTokenSymbol === endTokenSymbol) {
                routes.push({
                    hops: newPath,
                    finalAmountIn: initialAmountIn.toString(),
                    finalAmountOut: amountOutFromHop.toString()
                });
            } else {
                queue.push([nextTokenSymbol, newPath, amountOutFromHop]);
            }
        }
    }
    return routes.sort((a, b) => toBigInt(b.finalAmountOut) > toBigInt(a.finalAmountOut) ? 1 : -1)[0] || null;
}

// Calculate LP tokens to mint based on provided liquidity
// For initial liquidity: uses geometric mean (sqrt of product) for fair distribution
// For subsequent liquidity: uses proportional minting based on existing reserves
// Normalizes token amounts to 18 decimals for consistent calculations like pro DEXs
export function calculateLpTokensToMint(
    tokenA_amount: bigint, 
    tokenB_amount: bigint, 
    pool: LiquidityPoolData
): bigint {
    const NORMALIZED_DECIMALS = 18; // Normalize to 18 decimals like most pro DEXs
    
    // Get token decimals for normalization
    const tokenADecimals = getTokenDecimals(pool.tokenA_symbol);
    const tokenBDecimals = getTokenDecimals(pool.tokenB_symbol);
    
    // Normalize amounts to 18 decimals for consistent calculation
    const normalizedTokenA = normalizeToDecimals(tokenA_amount, tokenADecimals, NORMALIZED_DECIMALS);
    const normalizedTokenB = normalizeToDecimals(tokenB_amount, tokenBDecimals, NORMALIZED_DECIMALS);
    
    // Initial liquidity provision
    if (toBigInt(pool.totalLpTokens) === toBigInt(0)) {
        const product = normalizedTokenA * normalizedTokenB;
        const liquidity = sqrt(product);
        
        // Adaptive minimum liquidity: Use smaller of 1000 or liquidity/1000
        // This ensures small amounts can still provide liquidity
        const BASE_MINIMUM = toBigInt(1000);
        const ADAPTIVE_MINIMUM = liquidity / toBigInt(1000);
        const MINIMUM_LIQUIDITY = ADAPTIVE_MINIMUM > toBigInt(0) && ADAPTIVE_MINIMUM < BASE_MINIMUM 
            ? ADAPTIVE_MINIMUM 
            : BASE_MINIMUM;
        
        if (liquidity <= MINIMUM_LIQUIDITY) {
            return toBigInt(0); // Signal insufficient liquidity
        }
        
        return liquidity - MINIMUM_LIQUIDITY; // Burn minimum liquidity
    }
    
    // For subsequent liquidity provisions, mint proportional to existing reserves
    const poolTotalLpTokens = toBigInt(pool.totalLpTokens);
    const poolTokenAReserve = toBigInt(pool.tokenA_reserve);
    const poolTokenBReserve = toBigInt(pool.tokenB_reserve);
    
    // Protect against division by zero
    if (poolTokenAReserve === toBigInt(0) || poolTokenBReserve === toBigInt(0)) {
        return toBigInt(0);
    }
    
    // Normalize existing reserves for consistent ratio calculation
    const normalizedReserveA = normalizeToDecimals(poolTokenAReserve, tokenADecimals, NORMALIZED_DECIMALS);
    const normalizedReserveB = normalizeToDecimals(poolTokenBReserve, tokenBDecimals, NORMALIZED_DECIMALS);
    
    const ratioA = (normalizedTokenA * poolTotalLpTokens) / normalizedReserveA;
    const ratioB = (normalizedTokenB * poolTotalLpTokens) / normalizedReserveB;
    
    return ratioA < ratioB ? ratioA : ratioB;
}

/**
 * Normalize token amount to target decimal places
 * @param amount Token amount in its native decimals
 * @param currentDecimals Current decimal places of the token
 * @param targetDecimals Target decimal places to normalize to
 * @returns Normalized amount
 */
function normalizeToDecimals(amount: bigint, currentDecimals: number, targetDecimals: number): bigint {
    if (currentDecimals === targetDecimals) {
        return amount;
    }
    
    if (currentDecimals < targetDecimals) {
        // Scale up - multiply by 10^(targetDecimals - currentDecimals)
        const scaleFactor = toBigInt(10 ** (targetDecimals - currentDecimals));
        return amount * scaleFactor;
    } else {
        // Scale down - divide by 10^(currentDecimals - targetDecimals)
        const scaleFactor = toBigInt(10 ** (currentDecimals - targetDecimals));
        return amount / scaleFactor;
    }
}