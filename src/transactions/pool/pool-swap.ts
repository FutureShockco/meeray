import logger from '../../logger.js';
import { getAccount } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import validate from '../../validation/index.js';
import { PoolSwapData } from './pool-interfaces.js';
import {
    processAutoRouteSwap,
    processRoutedSwap,
    processSingleHopSwap,
    validateAutoRouteSwap,
    validateRoutedSwap,
    validateSingleHopSwap,
} from './pool-processor.js';

export async function validateTx(data: PoolSwapData, sender: string): Promise<boolean> {
    try {
        if (toBigInt(data.amountIn) <= 0n) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return false;
        }
        if (data.minAmountOut !== undefined && !validate.bigint(data.minAmountOut, false, false)) {
            logger.warn('[pool-swap] minAmountOut, if provided, must be a positive BigInt.');
            return false;
        }
        if (data.slippagePercent !== undefined && !validate.integer(data.slippagePercent, true, false, 100, 0)) {
            logger.warn('[pool-swap] slippagePercent must be between 0 and 100 percent.');
            return false;
        }
        const traderAccount = await getAccount(sender);
        if (!traderAccount) {
            logger.warn(`[pool-swap] Trader account ${sender} not found.`);
            return false;
        }
        // Check if this is a routed swap or single-hop swap
        if (data.hops && data.hops.length > 0) {
            // Multi-hop routed swap
            return await validateRoutedSwap(data, sender, traderAccount);
        } else if (data.poolId) {
            // Single-hop swap
            return await validateSingleHopSwap(data, sender, traderAccount);
        } else if (data.fromTokenSymbol && data.toTokenSymbol) {
            // Auto-route swap - find the best route
            return await validateAutoRouteSwap(data, sender, traderAccount);
        } else {
            logger.warn(
                '[pool-swap] Invalid swap data: must specify either poolId for single-hop, hops for multi-hop, or fromTokenSymbol/toTokenSymbol for auto-routing.'
            );
            return false;
        }
    } catch (error) {
        logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: PoolSwapData, sender: string, transactionId: string): Promise<boolean> {
    // Determine the type of swap and process accordingly
    if (data.hops && data.hops.length > 0) {
        // Multi-hop routed swap
        return await processRoutedSwap(data, sender, transactionId);
    } else if (data.poolId) {
        // Single-hop swap
        return await processSingleHopSwap(data, sender, transactionId);
    } else if (data.fromTokenSymbol && data.toTokenSymbol) {
        // Auto-route swap
        return await processAutoRouteSwap(data, sender, transactionId);
    } else {
        logger.error('[pool-swap] Invalid swap data: must specify either poolId, hops, or fromTokenSymbol/toTokenSymbol.');
        return false;
    }
}
