import logger from '../../logger.js';
import { getAccount } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import validate from '../../validation/index.js';
import { PoolSwapData } from './pool-interfaces.js';
import chain from '../../chain.js';

import {
    processAutoRouteSwap,
    processRoutedSwap,
    processSingleHopSwap,
    validateAutoRouteSwap,
    validateRoutedSwap,
    validateSingleHopSwap,
} from './pool-processor.js';

export async function validateTx(data: PoolSwapData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (toBigInt(data.amountIn) <= 0n) {
            logger.warn('[pool-swap] amountIn must be a positive BigInt.');
            return { valid: false, error: 'amountIn must be a positive BigInt' };
        }
        if (data.minAmountOut !== undefined && !validate.bigint(data.minAmountOut, false, false)) {
            logger.warn('[pool-swap] minAmountOut, if provided, must be a positive BigInt.');
            return { valid: false, error: 'minAmountOut must be a positive BigInt' };
        }
        if (data.slippagePercent !== undefined && !validate.integer(data.slippagePercent, true, false, 100, 0)) {
            logger.warn('[pool-swap] slippagePercent must be between 0 and 100 percent.');
            return { valid: false, error: 'slippagePercent must be between 0 and 100 percent' };
        }
        const senderAccount = await getAccount(sender);
        if (!senderAccount) {
            logger.warn(`[pool-swap] Trader account ${sender} not found.`);
            return { valid: false, error: 'Trader account not found' };
        }
        // Check if this is a routed swap or single-hop swap
        if (data.hops && data.hops.length > 0) {
            // Multi-hop routed swap
            const validation = await validateRoutedSwap(data, senderAccount);
            return { valid: validation, error: validation ? undefined : 'invalid routed swap' };
        } else if (data.poolId) {
            // Single-hop swap
            const validation = await validateSingleHopSwap(data, senderAccount);
            return { valid: validation, error: validation ? undefined : 'invalid single-hop swap' };
        } else if (data.fromTokenSymbol && data.toTokenSymbol) {
            // Auto-route swap - find the best route
            const validation = await validateAutoRouteSwap(data, senderAccount);
            return { valid: validation, error: validation ? undefined : 'invalid auto-route swap' };
        } else {
            logger.warn(
                '[pool-swap] Invalid swap data: must specify either poolId for single-hop, hops for multi-hop, or fromTokenSymbol/toTokenSymbol for auto-routing.'
            );
            return { valid: false, error: 'invalid swap data' };
        }
    } catch (error) {
        logger.error(`[pool-swap] Error validating swap data by ${sender}: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: PoolSwapData, sender: string, transactionId: string): Promise<{ valid: boolean; error?: string }> {
    // Get current block number for fee config
    const blockNum = chain.getLatestBlock()._id;
    if (data.hops && data.hops.length > 0) {
        // Multi-hop routed swap
        const validation = await processRoutedSwap(data, sender, transactionId, blockNum);
        return { valid: validation, error: validation ? undefined : 'invalid routed swap' };
    } else if (data.poolId) {
        // Single-hop swap
        const validation = await processSingleHopSwap(data, sender, transactionId, blockNum);
        return { valid: validation, error: validation ? undefined : 'invalid single-hop swap' };
    } else if (data.fromTokenSymbol && data.toTokenSymbol) {
        // Auto-route swap
        const validation = await processAutoRouteSwap(data, sender, transactionId, blockNum);
        return { valid: validation, error: validation ? undefined : 'invalid auto-route swap' };
    } else {
        logger.error('[pool-swap] Invalid swap data: must specify either poolId, hops, or fromTokenSymbol/toTokenSymbol.');
        return { valid: false, error: 'invalid swap data' };
    }
}
