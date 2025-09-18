import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { HybridTradeData, HybridTradeResult, HybridRoute } from './market-interfaces.js';
import { liquidityAggregator } from './market-aggregator.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt, getTokenDecimals, calculateDecimalAwarePrice, toDbString } from '../../utils/bigint.js';
import crypto from 'crypto';

// Import transaction processors for different route types
import * as poolSwap from '../pool/pool-swap.js';
import { PoolSwapResult } from '../pool/pool-interfaces.js';
import { calculateExpectedAMMOutput } from '../../utils/pool.js';
import { matchingEngine } from '../market/matching-engine.js';
import { OrderData, OrderType, OrderSide, OrderStatus, createOrder } from '../market/market-interfaces.js';

const NUMERIC_FIELDS_HYBRID_TRADE: Array<keyof HybridTradeData> = ['amountIn', 'minAmountOut', 'price'];



export async function validateTx(data: HybridTradeData, sender: string): Promise<boolean> {
  try {
    if (!data.tokenIn || !data.tokenOut || data.amountIn === undefined) {
      logger.warn('[hybrid-trade] Invalid data: Missing required fields (tokenIn, tokenOut, amountIn).');
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

    // Validate tokens by symbol only (issuer optional/ignored)
    const tokenInSymbol = data.tokenIn;
    const tokenOutSymbol = data.tokenOut;

    // Check if tokenIn exists by symbol
    const tokenInExists = await cache.findOnePromise('tokens', {
      symbol: tokenInSymbol
    });
    if (!tokenInExists) {
      logger.warn(`[hybrid-trade] Token ${data.tokenIn} does not exist. Symbol "${tokenInSymbol}" not found in the system.`);
      return false;
    }

    // Check if tokenOut exists by symbol
    const tokenOutExists = await cache.findOnePromise('tokens', {
      symbol: tokenOutSymbol
    });
    if (!tokenOutExists) {
      logger.warn(`[hybrid-trade] Token ${data.tokenOut} does not exist. Symbol "${tokenOutSymbol}" not found in the system.`);
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
      logger.warn('[hybrid-trade] Must specify either price, minAmountOut, or maxSlippagePercent. For market orders, maxSlippagePercent is recommended for better user experience.');
      return false;
    }
    
    if (hasMinAmountOut && hasMaxSlippage) {
      logger.warn('[hybrid-trade] Cannot specify both minAmountOut and maxSlippagePercent. Choose one slippage protection method.');
      return false;
    }

    // For market orders (no specific price), prefer maxSlippagePercent over minAmountOut
    if (!hasPrice && hasMinAmountOut && !hasMaxSlippage) {
      logger.info('[hybrid-trade] Using minAmountOut for market order. If AMM output is below this threshold, the trade will be routed to orderbook as a limit order for better price protection.');
    }

    if (hasPrice && toBigInt(data.price!) <= BigInt(0)) {
      logger.warn('[hybrid-trade] price must be positive.');
      return false;
    }

    if (hasMinAmountOut && toBigInt(data.minAmountOut!) < BigInt(0)) {
      logger.warn('[hybrid-trade] minAmountOut cannot be negative.');
      return false;
    }

    // Log info for very unusual minAmountOut ratios but allow all transactions
    // Token decimals can vary from 0 to 18, creating legitimate ratios up to 10^18
    if (hasMinAmountOut) {
      const amountIn = toBigInt(data.amountIn);
      const minAmountOut = toBigInt(data.minAmountOut!);
      
      // Only warn for extremely unusual ratios (more than 10^20 to catch obvious errors)
      if (minAmountOut > amountIn * BigInt(10) ** BigInt(20)) {
        logger.warn(`[hybrid-trade] minAmountOut ${minAmountOut} is unusually high compared to input amount ${amountIn}. Please verify this is correct.`);
      }
      
      // Always allow the transaction - different token decimals can create huge legitimate ratios
    }

    if (hasMaxSlippage && (data.maxSlippagePercent! < 0 || data.maxSlippagePercent! > 100)) {
      logger.warn('[hybrid-trade] maxSlippagePercent must be between 0 and 100.');
      return false;
    }

    // Check sender's balance
    const senderAccount = await getAccount(sender);
    if (!senderAccount) {
      logger.warn(`[hybrid-trade] Sender account ${sender} not found.`);
      return false;
    }

    const tokenInBalance = toBigInt(senderAccount.balances[data.tokenIn] || '0');
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

        // For AMM sources, validate that the expected output would be greater than 0
        const ammSources = sources.filter(source => source.type === 'AMM');
        for (const ammSource of ammSources) {
          if (ammSource.hasLiquidity) {
            const expectedOutput = calculateExpectedAMMOutput(
              toBigInt(data.amountIn),
              data.tokenIn,
              data.tokenOut,
              ammSource
            );
            
            if (expectedOutput === BigInt(0)) {
              logger.warn(`[hybrid-trade] AMM route would produce zero output for ${data.amountIn} ${data.tokenIn} -> ${data.tokenOut}. Trade would fail.`);
              return false;
            }
          }
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
      // Market order - try AMM first, fallback to orderbook if needed
      if (!data.price) {
        const quote = await liquidityAggregator.getBestQuote(data);
        if (!quote) {
          logger.warn('[hybrid-trade] No liquidity available for this trade. This should have been caught during validation.');
          return false;
        }

        // Check if AMM output meets minAmountOut requirement
        if (data.minAmountOut && toBigInt(quote.amountOut) < toBigInt(data.minAmountOut)) {
          // AMM output too low - use orderbook as limit order with calculated price
          // Calculate price considering different token decimals
          const calculatedPrice = calculateDecimalAwarePrice(
            toBigInt(data.amountIn), 
            toBigInt(data.minAmountOut), 
            data.tokenIn, 
            data.tokenOut
          );
          logger.info(`[hybrid-trade] AMM output ${quote.amountOut} below minAmountOut ${data.minAmountOut}. Routing to orderbook as limit order at calculated price ${calculatedPrice} (considering token decimals)`);
          
          // Find the correct trading pair ID regardless of token order
          const pairId = await findTradingPairId(data.tokenIn, data.tokenOut);
          if (!pairId) {
            logger.error(`[hybrid-trade] No trading pair found for ${data.tokenIn} and ${data.tokenOut}`);
            return false;
          }
          
          // Determine the correct order side
          const orderSide = await determineOrderSide(data.tokenIn, data.tokenOut, pairId);
          
          routes = [{
            type: 'ORDERBOOK',
            allocation: 100,
            details: {
              pairId: pairId,
              side: orderSide,
              orderType: OrderType.LIMIT,
              price: calculatedPrice.toString()
            }
          }];
        } else {
          // AMM output meets requirements - use AMM route
          routes = quote.routes.map(r => ({
            type: r.type,
            allocation: r.allocation,
            details: r.details
          }));
        }
      } else {
        // For limit orders with specific price, default to orderbook only
        logger.debug('[hybrid-trade] Using orderbook route for limit order with specific price');
        
        // Find the correct trading pair ID regardless of token order
        const pairId = await findTradingPairId(data.tokenIn, data.tokenOut);
        if (!pairId) {
          logger.error(`[hybrid-trade] No trading pair found for ${data.tokenIn} and ${data.tokenOut}`);
          return false;
        }
        
        // Determine the correct order side
        const orderSide = await determineOrderSide(data.tokenIn, data.tokenOut, pairId);
        
        routes = [{
          type: 'ORDERBOOK',
          allocation: 100,
          details: {
            pairId: pairId,
            side: orderSide,
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
        // Continue with other routes - partial execution is allowed
        // Individual route failures don't fail the entire trade unless all routes fail
      }
    }

    if (results.length === 0) {
      logger.error('[hybrid-trade] All routes failed to execute.');
      return false;
    }

    // Check slippage protection (this should rarely happen now with smart routing)
    if (data.minAmountOut) {
      const minOut = toBigInt(data.minAmountOut);
      // Determine if the final route is a limit order (not just if the original request had price)
      let finalRouteIsLimitOrder = false;
      if (routes.length === 1 && routes[0].type === 'ORDERBOOK') {
        const details = routes[0].details as any;
        finalRouteIsLimitOrder = details.orderType === OrderType.LIMIT;
      }
      const hadImmediateFill = totalAmountOut > BigInt(0);

      // If the final route is a limit order and there were no immediate fills,
      // don't treat the lack of immediate output as a slippage failure — the order was posted
      // to the book and may fill later. Only enforce minAmountOut when either the route is
      // not a limit order (e.g., market order routed through AMM/orderbook) or when
      // there were immediate fills to compare against.
      if (!finalRouteIsLimitOrder || hadImmediateFill) {
        if (totalAmountOut < minOut) {
          logger.warn(`[hybrid-trade] Slippage protection triggered: Output amount ${totalAmountOut} is less than minimum required ${data.minAmountOut}. This suggests the orderbook route also couldn't meet your price requirements. Consider adjusting your minAmountOut or using maxSlippagePercent.`);
          // In a production system, you'd want to rollback here
          return false;
        }
      } else {
        logger.info('[hybrid-trade] Limit order placed with no immediate fills; minAmountOut check deferred until fills occur.');
      }
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

    // Pre-validate that this route would produce non-zero output
    // This is an additional safeguard beyond the main validation
    if (ammDetails.expectedOutput && toBigInt(ammDetails.expectedOutput) === BigInt(0)) {
      return { success: false, amountOut: BigInt(0), error: 'Expected output is zero for this AMM route' };
    }
    
    // Create pool swap data
    const swapData = {
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

    // Record the AMM trade in the trades collection for market statistics
    await recordAMMTrade({
      poolId: ammDetails.poolId,
      tokenIn: tradeData.tokenIn,
      tokenOut: tradeData.tokenOut,
      amountIn: amountIn,
      amountOut: swapResult.amountOut,
      sender: sender,
      transactionId: transactionId
    });

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
    
    // Determine order type based on whether price is specified in tradeData OR route details
    const orderType = (tradeData.price || orderbookDetails.price) ? OrderType.LIMIT : OrderType.MARKET;
    
    // Get the trading pair to determine correct base/quote assignment
    const pair = await cache.findOnePromise('tradingPairs', { _id: orderbookDetails.pairId });
    if (!pair) {
      return { success: false, amountOut: BigInt(0), error: `Trading pair ${orderbookDetails.pairId} not found` };
    }
    
    // Calculate the correct quantity based on order side
    let orderQuantity: bigint;
    if (orderbookDetails.side === OrderSide.BUY) {
      // For buy orders, quantity should be the amount of base currency to buy
      // Calculate: quantity = amountIn (quote) / price
      const price = tradeData.price || orderbookDetails.price;
      if (!price) {
        return { success: false, amountOut: BigInt(0), error: 'Price required for buy orders' };
      }
      orderQuantity = amountIn / toBigInt(price);
    } else {
      // For sell orders, quantity is the amount of base currency to sell
      orderQuantity = amountIn;
    }

    // Create order (limit or market)
    const orderData: any = {
      userId: sender,
      pairId: orderbookDetails.pairId,
      type: orderType,
      side: orderbookDetails.side,
      quantity: orderQuantity,
      baseAssetSymbol: pair.baseAssetSymbol,
      quoteAssetSymbol: pair.quoteAssetSymbol
    };

    // Add price for limit orders (from tradeData or route details)
    if (orderType === OrderType.LIMIT) {
      orderData.price = tradeData.price || orderbookDetails.price;
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

/**
 * Determine the correct order side based on trading pair and token direction
 */
async function determineOrderSide(tokenIn: string, tokenOut: string, pairId: string): Promise<OrderSide> {
  // Get the trading pair to know which is base and which is quote
  const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
  if (!pair) {
    throw new Error(`Trading pair ${pairId} not found`);
  }
  
  const baseAsset = pair.baseAssetSymbol;
  const quoteAsset = pair.quoteAssetSymbol;
  
  // If we're buying the base asset (tokenOut = base), it's a BUY
  // If we're selling the base asset (tokenIn = base), it's a SELL
  if (tokenOut === baseAsset) {
    return OrderSide.BUY;  // Buying base with quote
  } else if (tokenIn === baseAsset) {
    return OrderSide.SELL; // Selling base for quote
  } else {
    throw new Error(`Invalid trade direction for pair ${pairId}: ${tokenIn} → ${tokenOut}`);
  }
}

/**
 * Find the correct trading pair ID regardless of token order
 */
async function findTradingPairId(tokenA: string, tokenB: string): Promise<string | null> {
  // Try both possible combinations
  const pairId1 = `${tokenA}-${tokenB}`;
  const pairId2 = `${tokenB}-${tokenA}`;
  
  // Check if either pair exists
  const pair1 = await cache.findOnePromise('tradingPairs', { _id: pairId1 });
  if (pair1) {
    return pairId1;
  }
  
  const pair2 = await cache.findOnePromise('tradingPairs', { _id: pairId2 });
  if (pair2) {
    return pairId2;
  }
  
  return null;
}

/**
 * Record AMM trade in the trades collection for market statistics
 */
async function recordAMMTrade(params: {
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  sender: string;
  transactionId: string;
}): Promise<void> {
  try {
    // Find the correct trading pair ID regardless of token order
    const pairId = await findTradingPairId(params.tokenIn, params.tokenOut);
    if (!pairId) {
      logger.warn(`[recordAMMTrade] No trading pair found for ${params.tokenIn}-${params.tokenOut}, skipping trade record`);
      return;
    }
    
    // Get the trading pair to determine correct base/quote assignment
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
      logger.warn(`[recordAMMTrade] Trading pair ${pairId} not found, using token symbols as-is`);
    }
    
    // Determine correct base/quote mapping and price calculation
    let baseSymbol, quoteSymbol, quantity, volume, priceValue;
    if (pair) {
      // Use actual pair configuration
      baseSymbol = pair.baseAssetSymbol;
      quoteSymbol = pair.quoteAssetSymbol;
      
      // Determine which direction the trade went
      if (params.tokenOut === baseSymbol) {
        // User bought base asset with quote asset
        quantity = params.amountOut; // Amount of base received
        volume = params.amountIn;    // Amount of quote spent
        priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
      } else {
        // User sold base asset for quote asset
        quantity = params.amountIn;  // Amount of base sold
        volume = params.amountOut;   // Amount of quote received
        priceValue = calculateDecimalAwarePrice(params.amountOut, params.amountIn, quoteSymbol, baseSymbol);
      }
    } else {
      // Fallback: calculate price with token decimal consideration
      baseSymbol = params.tokenOut;
      quoteSymbol = params.tokenIn;
      quantity = params.amountOut;
      volume = params.amountIn;
      priceValue = calculateDecimalAwarePrice(params.amountIn, params.amountOut, quoteSymbol, baseSymbol);
    }
    
    // Ensure price is not zero - if it is, calculate a simple price
    if (priceValue === 0n && quantity > 0n && volume > 0n) {
      // Calculate price considering decimal differences
      const tokenInDecimals = getTokenDecimals(params.tokenIn);
      const tokenOutDecimals = getTokenDecimals(params.tokenOut);
      const decimalDifference = tokenOutDecimals - tokenInDecimals;
      
      // Adjust for decimal differences in the calculation
      let adjustedVolume = volume;
      let adjustedQuantity = quantity;
      
      if (decimalDifference > 0) {
        // TokenOut has more decimals, scale up volume
        adjustedVolume = volume * BigInt(10 ** decimalDifference);
      } else if (decimalDifference < 0) {
        // TokenIn has more decimals, scale up quantity
        adjustedQuantity = quantity * BigInt(10 ** (-decimalDifference));
      }
      
      // Calculate price: (adjustedVolume * 1e8) / adjustedQuantity
      priceValue = (adjustedVolume * BigInt(1e8)) / adjustedQuantity;
      
      // Ensure price is never negative
      if (priceValue < 0n) {
        logger.error(`[recordAMMTrade] CRITICAL: Negative price calculated in fallback! Using 0 instead.`);
        priceValue = 0n;
      }
      
      logger.warn(`[recordAMMTrade] Price was 0, using decimal-aware calculation: ${priceValue} for ${volume} ${quoteSymbol}/${quantity} ${baseSymbol} (decimals: ${tokenInDecimals}/${tokenOutDecimals})`);
    }
    
    // Debug logging
    logger.info(`[recordAMMTrade] Trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut}`);
    logger.info(`[recordAMMTrade] Mapped: ${quantity} ${baseSymbol} (quantity), ${volume} ${quoteSymbol} (volume), price: ${priceValue}`);
    logger.info(`[recordAMMTrade] Pair: ${pairId}, Base: ${baseSymbol}, Quote: ${quoteSymbol}`);
    
    // Additional validation
    if (priceValue === 0n) {
      logger.error(`[recordAMMTrade] CRITICAL: Price is still 0 after all calculations!`);
      logger.error(`[recordAMMTrade] Input: ${params.amountIn} ${params.tokenIn}, Output: ${params.amountOut} ${params.tokenOut}`);
      logger.error(`[recordAMMTrade] Quantity: ${quantity}, Volume: ${volume}`);
    }
    
    // Final safety check - ensure price is never negative
    if (priceValue < 0n) {
      logger.error(`[recordAMMTrade] CRITICAL: Final price is negative! Setting to 0. Price: ${priceValue}`);
      priceValue = 0n;
    }
    
    // Determine the correct trade side based on token direction
    let tradeSide: 'buy' | 'sell';
    let buyerUserId: string;
    let sellerUserId: string;
    
    if (params.tokenOut === baseSymbol) {
      // User is buying the base asset (tokenOut = base), it's a BUY
      tradeSide = 'buy';
      buyerUserId = params.sender;
      sellerUserId = 'AMM';
    } else if (params.tokenIn === baseSymbol) {
      // User is selling the base asset (tokenIn = base), it's a SELL
      tradeSide = 'sell';
      buyerUserId = 'AMM';
      sellerUserId = params.sender;
    } else {
      // Fallback to buy if we can't determine the direction
      logger.warn(`[recordAMMTrade] Could not determine trade side for ${params.tokenIn} -> ${params.tokenOut}, defaulting to buy`);
      tradeSide = 'buy';
      buyerUserId = params.sender;
      sellerUserId = 'AMM';
    }

    // Create trade record matching the orderbook trade format
    const tradeRecord = {
      _id: crypto.randomBytes(12).toString('hex'),
      pairId: pairId,
      baseAssetSymbol: baseSymbol,
      quoteAssetSymbol: quoteSymbol,
      makerOrderId: null, // AMM trades don't have maker orders
      takerOrderId: null, // AMM trades don't have taker orders
      buyerUserId: buyerUserId,
      sellerUserId: sellerUserId,
      price: toDbString(priceValue), // Use toDbString for proper BigInt conversion
      quantity: toDbString(quantity),
      volume: toDbString(volume),
      timestamp: Date.now(),
      side: tradeSide,
      type: 'market', // AMM trades are market orders
      source: 'pool', // Mark as pool source (changed from 'amm' to match your data)
      isMakerBuyer: false,
      feeAmount: '0', // Fees are handled in the pool swap
      feeCurrency: quoteSymbol,
      makerFee: '0',
      takerFee: '0',
      total: toDbString(volume)
    };

    // Save to trades collection
    await new Promise<void>((resolve, reject) => {
      cache.insertOne('trades', tradeRecord, (err, result) => {
        if (err || !result) {
          logger.error(`[recordAMMTrade] Failed to record AMM trade: ${err}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    logger.debug(`[recordAMMTrade] Recorded AMM trade: ${params.amountIn} ${params.tokenIn} -> ${params.amountOut} ${params.tokenOut} via pool ${params.poolId}`);
  } catch (error) {
    logger.error(`[recordAMMTrade] Error recording AMM trade: ${error}`);
  }
}
