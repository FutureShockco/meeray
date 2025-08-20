import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { HybridTradeData, HybridTradeResult, HybridRoute } from './market-interfaces.js';
import { liquidityAggregator } from './market-aggregator.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';

// Import transaction processors for different route types
import * as poolSwap from '../pool/pool-swap.js';
import { PoolSwapResult } from '../pool/pool-interfaces.js';
import { matchingEngine } from '../market/matching-engine.js';
import { OrderData, OrderType, OrderSide, OrderStatus, createOrder } from '../market/market-interfaces.js';

const NUMERIC_FIELDS_HYBRID_TRADE: Array<keyof HybridTradeData> = ['amountIn', 'minAmountOut', 'price'];

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

    // Validate slippage protection vs price specification
    const hasPrice = data.price !== undefined;
    const hasMinAmountOut = data.minAmountOut !== undefined;
    const hasMaxSlippage = data.maxSlippagePercent !== undefined;
    
    if (hasPrice && (hasMinAmountOut || hasMaxSlippage)) {
      logger.warn('[hybrid-trade] Cannot specify price together with slippage protection (minAmountOut or maxSlippagePercent). Choose either specific price or slippage protection.');
      return false;
    }
    
    if (!hasPrice && !hasMinAmountOut && !hasMaxSlippage) {
      logger.warn('[hybrid-trade] Must specify either price, minAmountOut, or maxSlippagePercent.');
      return false;
    }
    
    if (hasMinAmountOut && hasMaxSlippage) {
      logger.warn('[hybrid-trade] Cannot specify both minAmountOut and maxSlippagePercent. Choose one slippage protection method.');
      return false;
    }

    if (hasPrice && toBigInt(data.price!) <= BigInt(0)) {
      logger.warn('[hybrid-trade] price must be positive.');
      return false;
    }

    if (hasMinAmountOut && toBigInt(data.minAmountOut!) < BigInt(0)) {
      logger.warn('[hybrid-trade] minAmountOut cannot be negative.');
      return false;
    }

    if (hasMaxSlippage && (data.maxSlippagePercent! < 0 || data.maxSlippagePercent! > 100)) {
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
    } else {
      // No routes provided - check if liquidity exists for auto-routing
      // Only check for market orders (no specific price) since limit orders default to orderbook
      if (!data.price) {
        const sources = await liquidityAggregator.getLiquiditySources(data.tokenIn, data.tokenOut);
        if (sources.length === 0) {
          logger.warn(`[hybrid-trade] No liquidity sources found for ${data.tokenIn}/${data.tokenOut}. Cannot auto-route trade.`);
          return false;
        }
        
        // Check if any source has actual liquidity
        const hasLiquidity = sources.some(source => {
          if (source.type === 'AMM') {
            return source.hasLiquidity;
          } else if (source.type === 'ORDERBOOK') {
            return (toBigInt(source.bidDepth || '0') > 0n) || (toBigInt(source.askDepth || '0') > 0n);
          }
          return false;
        });
        
        if (!hasLiquidity) {
          logger.warn(`[hybrid-trade] No liquidity available for ${data.tokenIn}/${data.tokenOut}. Pools exist but have no liquidity, and orderbook has no orders.`);
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
      // Only auto-route for market orders (no specific price)
      if (!data.price) {
        const quote = await liquidityAggregator.getBestQuote(data);
        if (!quote) {
          logger.warn('[hybrid-trade] No liquidity available for this trade. This should have been caught during validation.');
          return false;
        }
        routes = quote.routes.map(r => ({
          type: r.type,
          allocation: r.allocation,
          details: r.details
        }));
      } else {
        // For limit orders with specific price, default to orderbook only
        logger.debug('[hybrid-trade] Using orderbook route for limit order with specific price');
        routes = [{
          type: 'ORDERBOOK',
          allocation: 100,
          details: {
            pairId: `${data.tokenIn.split('@')[0]}-${data.tokenOut.split('@')[0]}`, // Simplified pair ID generation
            side: OrderSide.BUY, // Fixed - use enum value
            orderType: OrderType.LIMIT,
            price: data.price
          }
        }];
      }
    }

    // Execute trades across all routes
    if (!routes || routes.length === 0) {
      logger.error('[hybrid-trade] No routes available for execution.');
      return false;
    }

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
        routeResult = await executeAMMRoute(route, data, routeAmountIn, sender, transactionId);
      } else {
        routeResult = await executeOrderbookRoute(route, data, routeAmountIn, sender, transactionId);
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
  tradeData: HybridTradeData,
  amountIn: bigint,
  sender: string,
  transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
  try {
    const ammDetails = route.details as any; // AMMRouteDetails
    
    // Use user's slippagePercent if provided, otherwise default to 1%
    const slippagePercent = tradeData.maxSlippagePercent || 1.0;
    
    // Create pool swap data
    const swapData = {
      trader: sender,
      tokenIn_symbol: tradeData.tokenIn,
      tokenOut_symbol: tradeData.tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: '1', // Minimum 1 unit (route-level, overall slippage checked later)
      slippagePercent: slippagePercent, // Use user's slippage preference
      poolId: ammDetails.poolId,
      hops: ammDetails.hops
    };

    // Validate and execute the swap using the new function that returns output amount
    const isValid = await poolSwap.validateTx(swapData, sender);
    if (!isValid) {
      return { success: false, amountOut: BigInt(0), error: 'AMM swap validation failed' };
    }

    // Use the new processWithResult function to get the actual output amount
    const swapResult: PoolSwapResult = await poolSwap.processWithResult(swapData, sender, transactionId);
    
    if (!swapResult.success) {
      return { success: false, amountOut: BigInt(0), error: swapResult.error || 'AMM swap execution failed' };
    }

    // Return the actual output amount from the swap
    return { success: true, amountOut: swapResult.amountOut };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `AMM route error: ${error}` };
  }
}

/**
 * Execute trade through orderbook route
 */
async function executeOrderbookRoute(
  route: HybridRoute,
  tradeData: HybridTradeData,
  amountIn: bigint,
  sender: string,
  transactionId: string
): Promise<{ success: boolean; amountOut: bigint; error?: string }> {
  try {
    const orderbookDetails = route.details as any; // OrderbookRouteDetails
    
    // Determine order type based on whether price is specified
    const orderType = tradeData.price ? OrderType.LIMIT : OrderType.MARKET;
    
    // Create order (limit or market)
    const orderData: any = {
      userId: sender,
      pairId: orderbookDetails.pairId,
      type: orderType,
      side: orderbookDetails.side,
      quantity: amountIn,
      baseAssetSymbol: tradeData.tokenIn, // Simplified
      quoteAssetSymbol: tradeData.tokenOut // Simplified
    };

    // Add price for limit orders
    if (orderType === OrderType.LIMIT && tradeData.price) {
      orderData.price = tradeData.price;
    }

    const createdOrder = createOrder(orderData);

    // Submit to matching engine
    const result = await matchingEngine.addOrder(createdOrder);
    
    if (!result.accepted) {
      return { success: false, amountOut: BigInt(0), error: result.rejectReason };
    }

    // For limit orders, the order might not be filled immediately
    if (orderType === OrderType.LIMIT && result.trades.length === 0) {
      logger.info(`[hybrid-trade] Limit order placed at price ${tradeData.price}, waiting for matching`);
      return { success: true, amountOut: BigInt(0) }; // Order placed but not filled yet
    }

    // Calculate output from trades (for market orders or partially filled limit orders)
    const totalOutput = result.trades.reduce((sum, trade) => 
      sum + toBigInt(trade.quantity), BigInt(0));
    
    return { success: true, amountOut: totalOutput };
  } catch (error) {
    return { success: false, amountOut: BigInt(0), error: `Orderbook route error: ${error}` };
  }
}
