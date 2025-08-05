import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { HybridTradeData, HybridTradeResult, HybridRoute } from './market-interfaces.js';
import { liquidityAggregator } from './market-aggregator.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

// Import transaction processors for different route types
import * as poolSwap from '../pool/pool-swap.js';
import { matchingEngine } from '../market/matching-engine.js';
import { OrderData, OrderType, OrderSide, OrderStatus, createOrder } from '../market/market-interfaces.js';

const NUMERIC_FIELDS_HYBRID_TRADE: Array<keyof HybridTradeData> = ['amountIn', 'minAmountOut'];

export async function validateTx(data: HybridTradeData, sender: string): Promise<boolean> {
  try {
    if (!data.trader || !data.tokenIn || !data.tokenOut || data.amountIn === undefined) {
      logger.warn('[hybrid-trade] Invalid data: Missing required fields (trader, tokenIn, tokenOut, amountIn).');
      return false;
    }

    if (sender !== data.trader) {
      logger.warn('[hybrid-trade] Sender must be the trader.');
      return false;
    }

    if (!validate.string(data.tokenIn, 64, 1)) {
      logger.warn('[hybrid-trade] Invalid tokenIn format.');
      return false;
    }

    if (!validate.string(data.tokenOut, 64, 1)) {
      logger.warn('[hybrid-trade] Invalid tokenOut format.');
      return false;
    }

    if (data.tokenIn === data.tokenOut) {
      logger.warn('[hybrid-trade] Cannot trade the same token.');
      return false;
    }

    if (toBigInt(data.amountIn) <= BigInt(0)) {
      logger.warn('[hybrid-trade] amountIn must be positive.');
      return false;
    }

    if (data.minAmountOut !== undefined && toBigInt(data.minAmountOut) < BigInt(0)) {
      logger.warn('[hybrid-trade] minAmountOut cannot be negative.');
      return false;
    }

    if (data.maxSlippagePercent !== undefined && (data.maxSlippagePercent < 0 || data.maxSlippagePercent > 100)) {
      logger.warn('[hybrid-trade] maxSlippagePercent must be between 0 and 100.');
      return false;
    }

    // Check trader's balance
    const traderAccount = await getAccount(data.trader);
    if (!traderAccount) {
      logger.warn(`[hybrid-trade] Trader account ${data.trader} not found.`);
      return false;
    }

    const tokenInBalance = toBigInt(traderAccount.balances[data.tokenIn] || '0');
    if (tokenInBalance < toBigInt(data.amountIn)) {
      logger.warn(`[hybrid-trade] Insufficient balance for ${data.tokenIn}. Required: ${data.amountIn}, Available: ${tokenInBalance}`);
      return false;
    }

    // Validate routes if provided
    if (data.routes && data.routes.length > 0) {
      const totalAllocation = data.routes.reduce((sum, route) => sum + route.allocation, 0);
      if (Math.abs(totalAllocation - 100) > 0.01) {
        logger.warn('[hybrid-trade] Route allocations must sum to 100%.');
        return false;
      }

      for (const route of data.routes) {
        if (route.allocation <= 0 || route.allocation > 100) {
          logger.warn('[hybrid-trade] Route allocation must be between 0 and 100.');
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    logger.error(`[hybrid-trade] Error validating trade data by ${sender}: ${error}`);
    return false;
  }
}

export async function process(data: HybridTradeData, sender: string, transactionId: string): Promise<boolean> {
  try {
    logger.debug(`[hybrid-trade] Processing hybrid trade from ${sender}: ${data.amountIn} ${data.tokenIn} -> ${data.tokenOut}`);

    // Get optimal route if not provided
    let routes = data.routes;
    if (!routes || routes.length === 0) {
      const quote = await liquidityAggregator.getBestQuote(data);
      if (!quote) {
        logger.warn('[hybrid-trade] No liquidity available for this trade.');
        return false;
      }
      routes = quote.routes.map(r => ({
        type: r.type,
        allocation: r.allocation,
        details: r.details
      }));
    }

    // Execute trades across all routes
    const results: HybridTradeResult['executedRoutes'] = [];
    let totalAmountOut = BigInt(0);
    let totalAmountIn = BigInt(0);

    for (const route of routes) {
      const routeAmountIn = (toBigInt(data.amountIn) * BigInt(route.allocation)) / BigInt(100);
      
      if (routeAmountIn <= BigInt(0)) {
        continue;
      }

      let routeResult: { success: boolean; amountOut: bigint; error?: string };

      if (route.type === 'AMM') {
        routeResult = await executeAMMRoute(route, data.tokenIn, data.tokenOut, routeAmountIn, sender, transactionId);
      } else {
        routeResult = await executeOrderbookRoute(route, data.tokenIn, data.tokenOut, routeAmountIn, sender, transactionId);
      }

      if (routeResult.success) {
        results.push({
          type: route.type,
          amountIn: routeAmountIn.toString(),
          amountOut: routeResult.amountOut.toString(),
          transactionId
        });
        totalAmountOut += routeResult.amountOut;
        totalAmountIn += routeAmountIn;
      } else {
        logger.error(`[hybrid-trade] Failed to execute ${route.type} route: ${routeResult.error}`);
        // Rollback any successful routes if needed
        // For now, continue with other routes
      }
    }

    if (results.length === 0) {
      logger.error('[hybrid-trade] All routes failed to execute.');
      return false;
    }

    // Check slippage protection
    if (data.minAmountOut && totalAmountOut < toBigInt(data.minAmountOut)) {
      logger.warn(`[hybrid-trade] Output amount ${totalAmountOut} less than minimum required ${data.minAmountOut}`);
      // In a production system, you'd want to rollback here
      return false;
    }

    // Calculate actual price impact
    const actualPriceImpact = results.length > 0 ? 
      Number(totalAmountIn - totalAmountOut) / Number(totalAmountIn) : 0;

    // Log the successful trade
    const eventData = {
      trader: data.trader,
      tokenIn: data.tokenIn,
      tokenOut: data.tokenOut,
      amountIn: totalAmountIn.toString(),
      amountOut: totalAmountOut.toString(),
      actualPriceImpact,
      routesExecuted: results.length,
      routes: results
    };
    await logTransactionEvent('hybridTradeExecuted', sender, eventData, transactionId);

    logger.debug(`[hybrid-trade] Hybrid trade completed: ${totalAmountIn} ${data.tokenIn} -> ${totalAmountOut} ${data.tokenOut}`);
    return true;

  } catch (error) {
    logger.error(`[hybrid-trade] Error processing hybrid trade by ${sender}: ${error}`);
    return false;
  }
}

/**
 * Execute trade through AMM route
 */
async function executeAMMRoute(
  route: HybridRoute,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  sender: string,
  transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
  try {
    const ammDetails = route.details as any; // AMMRouteDetails
    
    // Create pool swap data
    const swapData = {
      trader: sender,
      tokenIn_symbol: tokenIn,
      tokenOut_symbol: tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: '1', // Minimum 1 unit (route-level, overall slippage checked later)
      poolId: ammDetails.poolId,
      hops: ammDetails.hops
    };

    // Validate and execute the swap
    const isValid = await poolSwap.validateTx(swapData, sender);
    if (!isValid) {
      return { success: false, amountOut: BigInt(0), error: 'AMM swap validation failed' };
    }

    const success = await poolSwap.process(swapData, sender, transactionId);
    if (!success) {
      return { success: false, amountOut: BigInt(0), error: 'AMM swap execution failed' };
    }

    // Calculate output (simplified - in real implementation, get from swap execution)
    // This would need to be returned from the pool swap process function
    const estimatedOutput = amountIn; // Placeholder - implement proper calculation
    
    return { success: true, amountOut: estimatedOutput };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `AMM route error: ${error}` };
  }
}

/**
 * Execute trade through orderbook route
 */
async function executeOrderbookRoute(
  route: HybridRoute,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  sender: string,
  transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
  try {
    const orderbookDetails = route.details as any; // OrderbookRouteDetails
    
    // Create market order
    const orderData = createOrder({
      userId: sender,
      pairId: orderbookDetails.pairId,
      type: OrderType.MARKET,
      side: orderbookDetails.side,
      quantity: amountIn,
      baseAssetSymbol: tokenIn, // Simplified
      quoteAssetSymbol: tokenOut // Simplified
    });

    // Submit to matching engine
    const result = await matchingEngine.addOrder(orderData);
    
    if (!result.accepted) {
      return { success: false, amountOut: BigInt(0), error: result.rejectReason };
    }

    // Calculate output from trades
    const totalOutput = result.trades.reduce((sum, trade) => 
      sum + toBigInt(trade.quantity), BigInt(0));
    
    return { success: true, amountOut: totalOutput };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `Orderbook route error: ${error}` };
  }
}
