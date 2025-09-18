import { OrderData, TradeData, TradingPairData, OrderStatus, OrderSide, OrderType } from './market-interfaces.js';
import { OrderBook, OrderBookMatchResult } from './orderbook.js';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { adjustBalance } from '../../utils/account.js';
import { toBigInt, toDbString, calculateTradeValue } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

/**
 * Distributes orderbook trading fees to AMM pool liquidity providers
 * This ensures orderbook fees contribute to liquidity growth like AMM fees
 */
async function distributeOrderbookFeesToLiquidityProviders(
  baseAssetSymbol: string,
  quoteAssetSymbol: string,
  baseTokenFee: bigint,
  quoteTokenFee: bigint
): Promise<void> {
  try {
    // Find the corresponding AMM pool for this trading pair
    const poolId = generatePoolIdFromTokens(baseAssetSymbol, quoteAssetSymbol);
    const pool = await cache.findOnePromise('liquidityPools', { _id: poolId });
    
    if (!pool) {
      // No AMM pool exists for this pair - fees are burned
      logger.debug(`[MatchingEngine] No AMM pool found for ${baseAssetSymbol}-${quoteAssetSymbol}, orderbook fees burned`);
      return;
    }

    const totalLpTokens = toBigInt(pool.totalLpTokens);
    if (totalLpTokens <= 0n) {
      // Pool exists but has no liquidity providers - fees are burned
      logger.debug(`[MatchingEngine] AMM pool ${poolId} has no LP tokens, orderbook fees burned`);
      return;
    }

    // Update fee growth globals using the same mechanism as AMM pool swaps
    let newFeeGrowthGlobalA = toBigInt(pool.feeGrowthGlobalA || '0');
    let newFeeGrowthGlobalB = toBigInt(pool.feeGrowthGlobalB || '0');

    // Determine which pool token corresponds to which trading pair asset
    const baseIsTokenA = pool.tokenA_symbol === baseAssetSymbol;
    const quoteIsTokenA = pool.tokenA_symbol === quoteAssetSymbol;

    // Distribute base token fees to the correct pool token
    if (baseTokenFee > 0n) {
      const feeGrowthDelta = (baseTokenFee * BigInt(1e18)) / totalLpTokens;
      if (baseIsTokenA) {
        newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
      } else {
        newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
      }
    }

    // Distribute quote token fees to the correct pool token
    if (quoteTokenFee > 0n) {
      const feeGrowthDelta = (quoteTokenFee * BigInt(1e18)) / totalLpTokens;
      if (quoteIsTokenA) {
        newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
      } else {
        newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
      }
    }

    // Update the pool's fee growth globals
    await cache.updateOnePromise('liquidityPools', { _id: poolId }, {
      $set: {
        feeGrowthGlobalA: toDbString(newFeeGrowthGlobalA),
        feeGrowthGlobalB: toDbString(newFeeGrowthGlobalB)
      }
    });

    logger.debug(`[MatchingEngine] Distributed orderbook fees to AMM pool ${poolId}: ${baseTokenFee} ${baseAssetSymbol}, ${quoteTokenFee} ${quoteAssetSymbol}`);
  } catch (error) {
    logger.error(`[MatchingEngine] Error distributing orderbook fees: ${error}`);
  }
}

/**
 * Generate pool ID from token symbols (same logic as pool creation)
 */
function generatePoolIdFromTokens(tokenA_symbol: string, tokenB_symbol: string): string {
  // Ensure canonical order to prevent duplicate pools (e.g., A-B vs B-A)
  const [token1, token2] = [tokenA_symbol, tokenB_symbol].sort();
  return `${token1}_${token2}`;
}

/**
 * Result returned by the MatchingEngine after processing an order.
 */
export interface EngineMatchResult {
  order: OrderData; // The final state of the taker order
  trades: TradeData[]; // Trades generated for this order
  accepted: boolean; // Was the order accepted and processed by the engine?
  rejectReason?: string; // Reason if not accepted or if an issue occurred
}

class MatchingEngine {
  private orderBooks: Map<string, OrderBook>; // Key: pairId

  constructor() {
    logger.trace('[MatchingEngine] Initializing...');
    this.orderBooks = new Map<string, OrderBook>();
    this._initializeBooks().catch(err => {
      logger.error('[MatchingEngine] CRITICAL: Failed to initialize order books during construction:', err);
    });
  }

  private async _initializeBooks(): Promise<void> {
    logger.trace('[MatchingEngine] Loading trading pairs and initializing order books...');
    const activePairsDB = await cache.findPromise('tradingPairs', { status: 'TRADING' }) as TradingPairData[] | null;

    if (!activePairsDB || activePairsDB.length === 0) {
      logger.warn('[MatchingEngine] No active trading pairs found to initialize.');
      logger.trace('[MatchingEngine] Order books initialization skipped: No active pairs loaded.');
      return;
    }

    const activePairs = activePairsDB.map(pairDB => ({
      ...pairDB,
      tickSize: toBigInt(pairDB.tickSize),
      lotSize: toBigInt(pairDB.lotSize),
      minNotional: toBigInt(pairDB.minNotional),
      minTradeAmount: toBigInt(pairDB.minTradeAmount),
      maxTradeAmount: toBigInt(pairDB.maxTradeAmount)
    }));

    for (const pair of activePairs) {
      const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
      this.orderBooks.set(pair._id, orderBook);
      logger.debug(`[MatchingEngine] Initialized order book for pair ${pair._id}.`);

      const openOrdersDB = await cache.findPromise('orders', {
        pairId: pair._id,
        status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
      }) as OrderData[] | null;

      if (openOrdersDB && openOrdersDB.length > 0) {
        const openOrders = openOrdersDB.map(orderDB => ({
          ...orderDB,
          price: toBigInt(orderDB.price!),
          quantity: toBigInt(orderDB.quantity),
          filledQuantity: toBigInt(orderDB.filledQuantity),
          averageFillPrice: orderDB.averageFillPrice ? toBigInt(orderDB.averageFillPrice) : undefined,
          cumulativeQuoteValue: orderDB.cumulativeQuoteValue ? toBigInt(orderDB.cumulativeQuoteValue) : undefined,
          quoteOrderQty: orderDB.quoteOrderQty ? toBigInt(orderDB.quoteOrderQty) : undefined
        }));
        
        logger.debug(`[MatchingEngine] Loading ${openOrders.length} open orders for pair ${pair._id}...`);
        for (const order of openOrders) {
          if (order.type === OrderType.LIMIT) {
            orderBook.addOrder(order);
          }
        }
      }
    }
    logger.debug('[MatchingEngine] Order books initialization completed.');
  }

  private async _getOrderBook(pairId: string): Promise<OrderBook | null> {
    if (this.orderBooks.has(pairId)) {
      return this.orderBooks.get(pairId)!;
    }
    
    logger.warn(`[MatchingEngine] Order book for pair ${pairId} not found. Attempting to load...`);
    const pairDB = await cache.findOnePromise('tradingPairs', { _id: pairId, status: 'TRADING'}) as TradingPairData | null;
    
    if (pairDB) {
      const pair = {
        ...pairDB,
        tickSize: toBigInt(pairDB.tickSize),
        lotSize: toBigInt(pairDB.lotSize),
        minNotional: toBigInt(pairDB.minNotional),
        minTradeAmount: toBigInt(pairDB.minTradeAmount),
        maxTradeAmount: toBigInt(pairDB.maxTradeAmount)
      };
      
      const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
      this.orderBooks.set(pair._id, orderBook);
      logger.debug(`[MatchingEngine] Lazily initialized order book for pair ${pair._id}.`);
      return orderBook;
    }
    
    logger.error(`[MatchingEngine] Could not find or load trading pair ${pairId} to get order book.`);
    return null;
  }

  public async warmupMarketData(): Promise<void> {
    logger.debug('[MatchingEngine] Starting market data warmup...');
    let activePairs: TradingPairData[] | null = null;
    
    try {
      const pairsResult = await cache.findPromise('tradingPairs', { status: 'TRADING' });
      activePairs = pairsResult as TradingPairData[]; 
    } catch (err) {
      logger.error('[MatchingEngine:warmupMarketData] Error fetching active trading pairs:', err);
      logger.error('[MatchingEngine:warmupMarketData] Aborting warmup due to error loading trading pairs.');
      return;
    }

    if (!activePairs || activePairs.length === 0) {
      logger.warn('[MatchingEngine:warmupMarketData] No active trading pairs found to initialize books for.');
      return;
    }

    logger.debug(`[MatchingEngine:warmupMarketData] Found ${activePairs.length} active trading pair(s). Initializing order books...`);
    let successfulBookInitializations = 0;

    for (const pair of activePairs) {
      if (!pair._id || !pair.tickSize || !pair.lotSize) {
        logger.warn(`[MatchingEngine:warmupMarketData] Trading pair ID: ${pair._id} has invalid/missing details (tickSize, lotSize). Skipping.`);
        continue;
      }
      
      const tickSize = toBigInt(pair.tickSize);
      const lotSize = toBigInt(pair.lotSize);
      const orderBook = new OrderBook(pair._id, tickSize, lotSize);
      this.orderBooks.set(pair._id, orderBook); 
      logger.debug(`[MatchingEngine:warmupMarketData] Initialized order book for pair ${pair._id}.`);

      let openOrders: OrderData[] | null = null;
      try {
        const ordersResult = await cache.findPromise('orders', {
          pairId: pair._id,
          status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
        });
        openOrders = ordersResult as OrderData[];
      } catch (err) {
        logger.error(`[MatchingEngine:warmupMarketData] Error fetching open orders for pair ${pair._id}:`, err);
        continue;
      }

      if (openOrders && openOrders.length > 0) {
        logger.debug(`[MatchingEngine:warmupMarketData] Loading ${openOrders.length} open order(s) for pair ${pair._id}...`);
        let ordersLoaded = 0;
        for (const order of openOrders) {
          if (order.type === OrderType.LIMIT) {
            try {
              const orderWithBigInt = {
                ...order,
                price: toBigInt(order.price!),
                quantity: toBigInt(order.quantity),
                filledQuantity: toBigInt(order.filledQuantity)
              };
              orderBook.addOrder(orderWithBigInt);
              ordersLoaded++;
            } catch (addOrderError) {
              logger.error(`[MatchingEngine:warmupMarketData] Error adding order ${order._id} to book for pair ${pair._id}:`, addOrderError);
            }
          } else {
            logger.warn(`[MatchingEngine:warmupMarketData] Skipping order ${order._id} for pair ${pair._id} due to non-LIMIT type: ${order.type}`);
          }
        }
        logger.debug(`[MatchingEngine:warmupMarketData] Successfully loaded ${ordersLoaded} order(s) into book for pair ${pair._id}.`);
      } else {
        logger.debug(`[MatchingEngine:warmupMarketData] No open orders found to load for pair ${pair._id}.`);
      }
      successfulBookInitializations++;
    }
    logger.debug(`[MatchingEngine:warmupMarketData] Market data warmup completed. Initialized ${successfulBookInitializations} order book(s) out of ${activePairs.length} active pair(s).`);
  }

  public async addOrder(takerOrderInput: OrderData): Promise<EngineMatchResult> {
    const takerOrder = takerOrderInput;
    logger.debug(`[MatchingEngine] Received order ${takerOrder._id} for pair ${takerOrder.pairId}: ${takerOrder.side} ${takerOrder.quantity.toString()} ${takerOrder.baseAssetSymbol} @ ${takerOrder.price ? takerOrder.price.toString() : takerOrder.type}`);
    
    const orderBook = await this._getOrderBook(takerOrder.pairId);
    if (!orderBook) {
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const orderForDB = {
        ...finalOrderState,
        price: finalOrderState.price !== undefined ? toDbString(toBigInt(finalOrderState.price)) : undefined,
        quantity: toDbString(toBigInt(finalOrderState.quantity)),
        filledQuantity: toDbString(toBigInt(finalOrderState.filledQuantity)),
        remainingQuantity: toDbString(toBigInt(finalOrderState.quantity) - toBigInt(finalOrderState.filledQuantity)),
        averageFillPrice: finalOrderState.averageFillPrice !== undefined ? toDbString(toBigInt(finalOrderState.averageFillPrice)) : undefined,
        cumulativeQuoteValue: finalOrderState.cumulativeQuoteValue !== undefined ? toDbString(toBigInt(finalOrderState.cumulativeQuoteValue)) : undefined,
        quoteOrderQty: finalOrderState.quoteOrderQty !== undefined ? toDbString(toBigInt(finalOrderState.quoteOrderQty)) : undefined
      };
      
      const existingOrderCheck = await cache.findOnePromise('orders', { _id: takerOrder._id });
      if (!existingOrderCheck) {
        await new Promise<void>((resolve, reject) => {
          cache.insertOne('orders', orderForDB, (errInsert) => {
            if (errInsert) {
              logger.error(`[MatchingEngine] Failed to insert order ${finalOrderState._id} (status: ${finalOrderState.status}) after rejection due to no order book:`, errInsert);
              return reject(errInsert);
            }
            resolve();
          });
        });
      } else {
        await cache.updateOnePromise('orders', {_id: takerOrder._id }, { $set: { status: OrderStatus.REJECTED, updatedAt: finalOrderState.updatedAt }});
      }
      return { order: finalOrderState, trades: [], accepted: false, rejectReason: `Trading pair ${takerOrder.pairId} not supported or inactive.` };
    }

    const pairDetailsDB = await cache.findOnePromise('tradingPairs', {_id: takerOrder.pairId}) as TradingPairData | null;
    if(!pairDetailsDB) {
      logger.error(`[MatchingEngine] CRITICAL: Could not find pair details for order ${takerOrder._id}. Rejecting order.`);
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const orderForDB = {
        ...finalOrderState,
        price: finalOrderState.price !== undefined ? toDbString(toBigInt(finalOrderState.price)) : undefined,
        quantity: toDbString(toBigInt(finalOrderState.quantity)),
        filledQuantity: toDbString(toBigInt(finalOrderState.filledQuantity)),
        remainingQuantity: toDbString(toBigInt(finalOrderState.quantity) - toBigInt(finalOrderState.filledQuantity))
      };
      
      const existingOrderCheck = await cache.findOnePromise('orders', { _id: takerOrder._id });
      if (!existingOrderCheck) {
        await new Promise<void>((resolve, reject) => {
          cache.insertOne('orders', orderForDB, (errInsert) => {
            if (errInsert) {
              logger.error(`[MatchingEngine] Failed to insert order ${finalOrderState._id} (status: ${finalOrderState.status}) after pair details check:`, errInsert);
              return reject(errInsert);
            }
            resolve();
          });
        });
      } else {
        await cache.updateOnePromise('orders', {_id: takerOrder._id }, { $set: { status: OrderStatus.REJECTED, updatedAt: finalOrderState.updatedAt }});
      }
      return { order: finalOrderState, trades: [], accepted: false, rejectReason: `Internal error: trading pair ${takerOrder.pairId} details not found.` };
    }
    
    const pairDetails = {
      ...pairDetailsDB,
      tickSize: toBigInt(pairDetailsDB.tickSize),
      lotSize: toBigInt(pairDetailsDB.lotSize),
      minNotional: toBigInt(pairDetailsDB.minNotional),
      minTradeAmount: toBigInt(pairDetailsDB.minTradeAmount),
      maxTradeAmount: toBigInt(pairDetailsDB.maxTradeAmount)
    };

    const existingOrderDB = await cache.findOnePromise('orders', { _id: takerOrder._id }) as OrderData | null;
    if (!existingOrderDB) {
      const orderToInsertDB = {
        ...takerOrder,
        price: takerOrder.price !== undefined ? toDbString(toBigInt(takerOrder.price)) : undefined,
        quantity: toDbString(toBigInt(takerOrder.quantity)),
        filledQuantity: toDbString(toBigInt(takerOrder.filledQuantity)),
        remainingQuantity: toDbString(toBigInt(takerOrder.quantity) - toBigInt(takerOrder.filledQuantity)),
        averageFillPrice: takerOrder.averageFillPrice !== undefined ? toDbString(toBigInt(takerOrder.averageFillPrice)) : undefined,
        cumulativeQuoteValue: takerOrder.cumulativeQuoteValue !== undefined ? toDbString(toBigInt(takerOrder.cumulativeQuoteValue)) : undefined,
        quoteOrderQty: takerOrder.quoteOrderQty !== undefined ? toDbString(toBigInt(takerOrder.quoteOrderQty)) : undefined
      };
      
      await new Promise<void>((resolve, reject) => {
        cache.insertOne('orders', orderToInsertDB, (err, result) => {
          if (err || !result) {
            logger.error(`[MatchingEngine] Failed to insert initial state of order ${takerOrder._id}:`, err || 'no result');
            return reject(err || new Error('Insert failed'));
          }
          resolve();
        });
      });
    }

    const matchOutput = orderBook.matchOrder(takerOrder);
    const tradesAppFormat: TradeData[] = matchOutput.trades.map(t => ({
      ...t, 
      price: toBigInt(t.price), 
      quantity: toBigInt(t.quantity)
    }));
    
    // Handle remaining portion of partially filled limit orders
    if (matchOutput.takerOrderRemaining && matchOutput.takerOrderRemaining.type === OrderType.LIMIT) {
      logger.debug(`[MatchingEngine] Adding remaining portion of order ${takerOrder._id} back to orderbook: ${matchOutput.takerOrderRemaining.quantity.toString()}`);
      orderBook.addOrder(matchOutput.takerOrderRemaining);
    }
    
    let allUpdatesSuccessful = true;

    if (tradesAppFormat.length > 0) {
      logger.debug(`[MatchingEngine] Order ${takerOrder._id} generated ${tradesAppFormat.length} trades.`);
      for (const trade of tradesAppFormat) {
        const tradeForDB = {
          ...trade,
          price: toDbString(toBigInt(trade.price)),
          quantity: toDbString(toBigInt(trade.quantity)),
          feeAmount: trade.feeAmount !== undefined ? toDbString(toBigInt(trade.feeAmount)) : undefined,
          makerFee: trade.makerFee !== undefined ? toDbString(toBigInt(trade.makerFee)) : undefined,
          takerFee: trade.takerFee !== undefined ? toDbString(toBigInt(trade.takerFee)) : undefined,
          total: toDbString(toBigInt(trade.total))
        };
        
        const tradePersisted = await new Promise<boolean>((resolve) => {
          cache.insertOne('trades', tradeForDB, (err, result) => {
            if (err || !result) {
              logger.error(`[MatchingEngine] CRITICAL: Failed to persist trade ${trade._id} for order ${takerOrder._id}.`);
              resolve(false);
            } else {
              resolve(true);
            }
          });
        });
        
        if (!tradePersisted) {
          allUpdatesSuccessful = false;
          continue;
        }

        // Log trade execution event
        await logTransactionEvent('market_order_filled', trade.buyerUserId, {
          marketId: takerOrder.pairId,
          orderId: takerOrder._id,
          tradeId: trade._id,
          side: takerOrder.side, // Use the taker order's side
          price: toDbString(toBigInt(trade.price)),
          quantity: toDbString(toBigInt(trade.quantity)),
          buyerUserId: trade.buyerUserId,
          sellerUserId: trade.sellerUserId,
          baseAsset: pairDetails.baseAssetSymbol,
          quoteAsset: pairDetails.quoteAssetSymbol
        });

        const baseTokenIdentifier = pairDetails.baseAssetSymbol;
        const quoteTokenIdentifier = pairDetails.quoteAssetSymbol;
        const tradePriceBigInt = toBigInt(trade.price);
        const tradeQuantityBigInt = toBigInt(trade.quantity);
        
        // Calculate trade value considering decimal differences between base and quote tokens
        const tradeValue = calculateTradeValue(tradePriceBigInt, tradeQuantityBigInt, baseTokenIdentifier, quoteTokenIdentifier);

        // Apply 0.3% fee split between buyer and seller (0.15% each)
        const feeRate = BigInt(150); // 0.15% in basis points for each party
        const feeDivisor = BigInt(10000);
        
        // Calculate fees for both parties
        const baseTokenFee = (tradeQuantityBigInt * feeRate) / feeDivisor; // Fee on base token (taken from buyer)
        const quoteTokenFee = (tradeValue * feeRate) / feeDivisor; // Fee on quote token (taken from seller)
        
        // Apply trades with fees
        // Seller: loses base tokens, gains quote tokens minus fee
        // Buyer: gains base tokens minus fee, loses quote tokens
        const adjSellerBase = await adjustBalance(trade.sellerUserId, baseTokenIdentifier, -tradeQuantityBigInt);
        const adjBuyerBase = await adjustBalance(trade.buyerUserId, baseTokenIdentifier, tradeQuantityBigInt - baseTokenFee);
        const adjSellerQuote = await adjustBalance(trade.sellerUserId, quoteTokenIdentifier, tradeValue - quoteTokenFee);
        const adjBuyerQuote = await adjustBalance(trade.buyerUserId, quoteTokenIdentifier, -tradeValue);

        // Distribute orderbook fees to corresponding AMM pool liquidity providers
        // This creates a unified economic model where all trading activity benefits liquidity providers
        await distributeOrderbookFeesToLiquidityProviders(
          pairDetails.baseAssetSymbol, 
          pairDetails.quoteAssetSymbol, 
          baseTokenFee, 
          quoteTokenFee
        );

        // Log fee collection for analytics
        await logTransactionEvent('orderbook_fee_collected', 'system', {
          marketId: takerOrder.pairId,
          tradeId: trade._id,
          baseFee: toDbString(baseTokenFee),
          quoteFee: toDbString(quoteTokenFee),
          baseAsset: pairDetails.baseAssetSymbol,
          quoteAsset: pairDetails.quoteAssetSymbol,
          totalFeePercent: "0.3" // 0.15% + 0.15% = 0.3% total
        });

        if (!adjSellerBase || !adjBuyerBase || !adjSellerQuote || !adjBuyerQuote) {
          logger.error(`[MatchingEngine] CRITICAL: Balance adjustment failed for trade ${trade._id}.`);
          allUpdatesSuccessful = false;
        }
      }
    }

    // Log order placement event
    await logTransactionEvent('market_order_placed', takerOrder.userId, {
      marketId: takerOrder.pairId,
      orderId: takerOrder._id,
      side: takerOrder.side,
      type: takerOrder.type,
      price: takerOrder.price ? toDbString(toBigInt(takerOrder.price)) : 'MARKET',
      quantity: toDbString(toBigInt(takerOrder.quantity)),
      baseAsset: pairDetails.baseAssetSymbol,
      quoteAsset: pairDetails.quoteAssetSymbol
    });

    for (const makerOrderId of matchOutput.removedMakerOrders) {
      await cache.updateOnePromise('orders', { _id: makerOrderId }, { 
        $set: { 
          status: OrderStatus.FILLED, 
          remainingQuantity: "0",
          updatedAt: new Date().toISOString() 
        } 
      });
    }
    
    if (matchOutput.updatedMakerOrder) {
      const { _id, filledQuantity, quantity, status, averageFillPrice, cumulativeQuoteValue } = matchOutput.updatedMakerOrder;
      const makerRemainingQuantity = toBigInt(quantity) - toBigInt(filledQuantity);
      const updateSet = {
        filledQuantity: toDbString(toBigInt(filledQuantity)), 
        remainingQuantity: toDbString(makerRemainingQuantity),
        status,
        averageFillPrice: averageFillPrice ? toDbString(toBigInt(averageFillPrice)) : undefined,
        cumulativeQuoteValue: cumulativeQuoteValue ? toDbString(toBigInt(cumulativeQuoteValue)) : undefined,
        updatedAt: new Date().toISOString()
      };
      await cache.updateOnePromise('orders', { _id }, { $set: updateSet });
    }

    let finalTakerStatus = takerOrder.status;
    if (takerOrder.filledQuantity >= takerOrder.quantity) {
      finalTakerStatus = OrderStatus.FILLED;
    }

    takerOrder.status = finalTakerStatus;
    takerOrder.updatedAt = new Date().toISOString();
    
    // Calculate remaining quantity
    const remainingQuantity = toBigInt(takerOrder.quantity) - toBigInt(takerOrder.filledQuantity);
    
    // Update status based on remaining quantity
    if (remainingQuantity === 0n) {
      takerOrder.status = OrderStatus.FILLED;
    } else if (toBigInt(takerOrder.filledQuantity) > 0n) {
      takerOrder.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    if (tradesAppFormat.length > 0 && toBigInt(takerOrder.filledQuantity) > 0n) {
      let cumulativeValue = 0n;
      let totalQuantityFilled = 0n;
      tradesAppFormat.forEach(t => {
        const tPriceBigInt = toBigInt(t.price);
        const tQuantityBigInt = toBigInt(t.quantity);
        cumulativeValue = cumulativeValue + (tPriceBigInt * tQuantityBigInt);
        totalQuantityFilled = totalQuantityFilled + tQuantityBigInt;
      });
      if (totalQuantityFilled > 0n) {
        takerOrder.averageFillPrice = cumulativeValue / totalQuantityFilled;
      }
      takerOrder.cumulativeQuoteValue = cumulativeValue;
    }

    const finalTakerOrderForDB = {
      ...takerOrder,
      price: takerOrder.price !== undefined ? toDbString(toBigInt(takerOrder.price)) : undefined,
      quantity: toDbString(toBigInt(takerOrder.quantity)),
      filledQuantity: toDbString(toBigInt(takerOrder.filledQuantity)),
      remainingQuantity: toDbString(remainingQuantity),
      averageFillPrice: takerOrder.averageFillPrice !== undefined ? toDbString(toBigInt(takerOrder.averageFillPrice)) : undefined,
      cumulativeQuoteValue: takerOrder.cumulativeQuoteValue !== undefined ? toDbString(toBigInt(takerOrder.cumulativeQuoteValue)) : undefined,
      quoteOrderQty: takerOrder.quoteOrderQty !== undefined ? toDbString(toBigInt(takerOrder.quoteOrderQty)) : undefined
    };
    await cache.updateOnePromise('orders', { _id: takerOrder._id }, { $set: finalTakerOrderForDB });

    if (!allUpdatesSuccessful) {
      return { order: takerOrder, trades: tradesAppFormat, accepted: true, rejectReason: "Processed with some errors, check logs." };
    }
    
    logger.debug(`[MatchingEngine] Finished processing order ${takerOrder._id}. Final status: ${takerOrder.status}, Filled: ${takerOrder.filledQuantity.toString()}`);
    return { order: takerOrder, trades: tradesAppFormat, accepted: true };
  }

  public async cancelOrder(orderId: string, pairId: string, userId: string): Promise<boolean> {
    logger.debug(`[MatchingEngine] Received cancel request for order: ${orderId} on pair ${pairId} by user ${userId}`);
    const orderBook = await this._getOrderBook(pairId);
    if (!orderBook) {
      logger.error(`[MatchingEngine] Cannot cancel order ${orderId}: Order book for pair ${pairId} not found.`);
      return false;
    }

    const orderToCancelDB = await cache.findOnePromise('orders', { _id: orderId, userId: userId }) as OrderData | null;
    if (!orderToCancelDB) {
      logger.warn(`[MatchingEngine] Order ${orderId} not found for cancellation by user ${userId}.`);
      return false;
    }
    
    const orderToCancel = {
      ...orderToCancelDB,
      price: orderToCancelDB.price ? toBigInt(orderToCancelDB.price) : undefined,
      quantity: toBigInt(orderToCancelDB.quantity),
      filledQuantity: toBigInt(orderToCancelDB.filledQuantity)
    };

    if (orderToCancel.status !== OrderStatus.OPEN && orderToCancel.status !== OrderStatus.PARTIALLY_FILLED) {
      logger.warn(`[MatchingEngine] Order ${orderId} is not in a cancellable state (${orderToCancel.status}).`);
      return false;
    }

    const removed = orderBook.removeOrder(orderId);
    if (removed) {
      const updatedInDb = await cache.updateOnePromise('orders', { _id: orderId }, { $set: { status: OrderStatus.CANCELLED, updatedAt: new Date().toISOString() } });
      if (!updatedInDb) {
        logger.error(`[MatchingEngine] CRITICAL: Order ${orderId} removed from book but FAILED to mark CANCELLED in DB.`);
        return false;
      }

      // Log order cancellation event
      await logTransactionEvent('market_order_cancelled', userId, {
        marketId: pairId,
        orderId: orderId,
        side: orderToCancel.side,
        type: orderToCancel.type,
        price: orderToCancel.price ? toDbString(toBigInt(orderToCancel.price)) : 'MARKET',
        quantity: toDbString(toBigInt(orderToCancel.quantity)),
        filledQuantity: toDbString(toBigInt(orderToCancel.filledQuantity)),
        baseAsset: orderToCancel.baseAssetSymbol,
        quoteAsset: orderToCancel.quoteAssetSymbol
      });

      logger.debug(`[MatchingEngine] Order ${orderId} removed from book and marked CANCELLED.`);
      return true;
    } else {
      const currentOrderState = await cache.findOnePromise('orders', { _id: orderId }) as OrderData | null;
      if (currentOrderState && (currentOrderState.status === OrderStatus.FILLED || currentOrderState.status === OrderStatus.CANCELLED)) {
        logger.debug(`[MatchingEngine] Order ${orderId} already filled or cancelled in DB. Considered success for cancellation attempt.`);
        return true;
      }
      logger.warn(`[MatchingEngine] Failed to remove order ${orderId} from book. It might not have been found or already processed.`);
      return false;
    }
  }
}

export const matchingEngine = new MatchingEngine();
