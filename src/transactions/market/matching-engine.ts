import { Order, Trade, TradingPair, OrderStatus, OrderSide, OrderType } from './market-interfaces.js';
import { OrderBook, OrderBookMatchResult } from './orderbook.js';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { adjustBalance } from '../../utils/account-utils.js';
import { Decimal } from 'decimal.js';

/**
 * Result returned by the MatchingEngine after processing an order.
 */
export interface EngineMatchResult {
  order: Order; // The final state of the taker order
  trades: Trade[]; // Trades generated for this order
  accepted: boolean; // Was the order accepted and processed by the engine?
  rejectReason?: string; // Reason if not accepted or if an issue occurred
}

// This will be a complex module responsible for:
// 1. Maintaining in-memory order books for each trading pair.
// 2. Accepting new orders and matching them against the book.
// 3. Generating trades.
// 4. Persisting orders and trades.
// 5. Emitting events (e.g., order updates, new trades).

interface MatchResult {
  accepted: boolean;
  rejectReason?: string;
  finalOrderStatus?: string; // e.g. FILLED, PARTIALLY_FILLED, OPEN
  trades?: any[]; // Array of Trade objects
  // ... other details
}

class MatchingEngine {
  private orderBooks: Map<string, OrderBook>; // Key: pairId

  constructor() {
    logger.debug('[MatchingEngine] Initializing...');
    this.orderBooks = new Map<string, OrderBook>();
    this._initializeBooks().catch(err => {
      logger.error('[MatchingEngine] CRITICAL: Failed to initialize order books during construction:', err);
      // In a real system, this might prevent the engine from starting or put it in a degraded state.
    });
  }

  private async _initializeBooks(): Promise<void> {
    logger.debug('[MatchingEngine] Loading trading pairs and initializing order books...');
    const activePairs = await new Promise<TradingPair[] | null>((resolve) => {
      // Assuming cache.find exists and takes a callback. If not, this needs to be an equivalent method.
      // Based on cache.ts, cache.find does not exist.
      if (typeof (cache as any).find === 'function') {
        (cache as any).find('tradingPairs', { status: 'TRADING' }, (err: any, result: TradingPair[] | null) => {
          if (err) {
            logger.error('[MatchingEngine] Error finding active trading pairs:', err);
            resolve(null);
          } else {
            resolve(result);
          }
        });
      } else {
        logger.warn('[MatchingEngine] cache.find method not available for tradingPairs. Skipping pair loading.');
        resolve(null);
      }
    });

    if (!activePairs || activePairs.length === 0) {
      logger.warn('[MatchingEngine] No active trading pairs found to initialize.');
      // Ensure the final log reflects this outcome
      logger.debug('[MatchingEngine] Order books initialization skipped: No active pairs loaded.');
      return;
    }

    for (const pair of activePairs) { // This loop will likely not run
      const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
      this.orderBooks.set(pair._id, orderBook);
      logger.debug(`[MatchingEngine] Initialized order book for pair ${pair._id}.`);

      // Temporarily commenting out open order loading due to uncertainty with cache.find
      // Confirmed: cache.find does not exist. This logic needs a new cache method to function.
      /*
      const openOrders = await new Promise<Order[] | null>((resolve) => {
        if (typeof (cache as any).find === 'function') {
          (cache as any).find('orders', {
            pairId: pair._id,
            status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
          }, (err: any, result: Order[] | null) => {
            if (err) {
              logger.error(`[MatchingEngine] Error finding open orders for pair ${pair._id}:`, err);
              resolve(null);
            } else {
              resolve(result);
            }
          });
        } else {
          logger.warn(`[MatchingEngine] cache.find method not available for open orders on pair ${pair._id}. Skipping open order loading.`);
          resolve(null);
        }
      });

      if (openOrders && openOrders.length > 0) {
        logger.debug(`[MatchingEngine] Loading ${openOrders.length} open orders for pair ${pair._id}...`);
        for (const order of openOrders) {
          if (order.type === OrderType.LIMIT) {
            orderBook.addOrder(order);
          }
        }
      }
      */
    }
    logger.debug('[MatchingEngine] Order books initialization attempted (pair/order loading may be skipped due to missing cache.find).');
  }

  private async _getOrderBook(pairId: string): Promise<OrderBook | null> {
    if (this.orderBooks.has(pairId)) {
      return this.orderBooks.get(pairId)!;
    }
    logger.warn(`[MatchingEngine] Order book for pair ${pairId} not found. Attempting to load...`);
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId, status: 'TRADING'}) as TradingPair | null;
    if (pair) {
        const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
        this.orderBooks.set(pair._id, orderBook);
        logger.debug(`[MatchingEngine] Lazily initialized order book for pair ${pair._id}.`);
        // TODO: Potentially load open orders for this newly lazy-loaded book.
        return orderBook;
    }
    logger.error(`[MatchingEngine] Could not find or load trading pair ${pairId} to get order book.`);
    return null;
  }

  public async warmupMarketData(): Promise<void> {
    logger.debug('[MatchingEngine] Starting market data warmup...');
    let activePairs: TradingPair[] | null = null;
    try {
      // Ensure cache.findPromise exists and is correctly typed in cache.ts
      const pairsResult = await cache.findPromise('tradingPairs', { status: 'TRADING' });
      activePairs = pairsResult as TradingPair[]; 
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
          // Using pair._id for logging as pair.symbol might not exist
          logger.warn(`[MatchingEngine:warmupMarketData] Trading pair ID: ${pair._id} has invalid/missing details (tickSize, lotSize). Skipping.`);
          continue;
      }
      const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
      this.orderBooks.set(pair._id, orderBook); 
      // Using pair._id for logging
      logger.debug(`[MatchingEngine:warmupMarketData] Initialized order book for pair ${pair._id}.`);

      let openOrders: Order[] | null = null;
      try {
        const ordersResult = await cache.findPromise('orders', {
          pairId: pair._id,
          status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
        });
        openOrders = ordersResult as Order[];
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
              orderBook.addOrder(order); // Assuming this returns void and throws on error
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

  public async addOrder(takerOrder: Order): Promise<EngineMatchResult> {
    logger.debug(`[MatchingEngine] Received order ${takerOrder._id} for pair ${takerOrder.pairId}: ${takerOrder.side} ${takerOrder.quantity} ${takerOrder.baseAssetSymbol} @ ${takerOrder.price || takerOrder.type}`);
    
    const orderBook = await this._getOrderBook(takerOrder.pairId);
    if (!orderBook) {
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const existingOrderCheck = await cache.findOnePromise('orders', { _id: takerOrder._id });
      if (!existingOrderCheck) {
        await new Promise<void>((resolve, reject) => {
          cache.insertOne('orders', finalOrderState, (errInsert) => {
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

    const pairDetails = await cache.findOnePromise('tradingPairs', {_id: takerOrder.pairId}) as TradingPair | null;
    if(!pairDetails) {
        logger.error(`[MatchingEngine] CRITICAL: Could not find pair details for order ${takerOrder._id}. Rejecting order.`);
        const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
        const existingOrderCheck = await cache.findOnePromise('orders', { _id: takerOrder._id });
        if (!existingOrderCheck) {
            await new Promise<void>((resolve, reject) => {
              cache.insertOne('orders', finalOrderState, (errInsert) => {
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

    const existingOrder = await cache.findOnePromise('orders', { _id: takerOrder._id }) as Order | null;
    if (!existingOrder) {
        await new Promise<void>((resolve, reject) => {
          cache.insertOne('orders', takerOrder, (errInsert) => {
            if (errInsert) {
              logger.error(`[MatchingEngine] Failed to insert initial state of order ${takerOrder._id}:`, errInsert);
              return reject(errInsert);
            }
            resolve();
          });
        });
    }

    const matchOutput = orderBook.matchOrder(takerOrder);
    const trades: Trade[] = matchOutput.trades;
    let allUpdatesSuccessful = true;

    if (trades.length > 0) {
      logger.debug(`[MatchingEngine] Order ${takerOrder._id} generated ${trades.length} trades.`);
      for (const trade of trades) {
        const tradePersisted = await new Promise<boolean>(resolve => {
          cache.insertOne('trades', trade, (err:any, res:any) => err || !res ? resolve(false) : resolve(true) );
        });
        if (!tradePersisted) {
          logger.error(`[MatchingEngine] CRITICAL: Failed to persist trade ${trade._id} for order ${takerOrder._id}.`);
          allUpdatesSuccessful = false;
          continue;
        }
        
        const baseTokenIdentifier = `${pairDetails.baseAssetSymbol}@${pairDetails.baseAssetIssuer}`;
        const quoteTokenIdentifier = `${pairDetails.quoteAssetSymbol}@${pairDetails.quoteAssetIssuer}`;
        const tradeQuantity = new Decimal(trade.quantity);
        const tradeValue = new Decimal(trade.price).times(tradeQuantity);

        const adjSellerBase = await adjustBalance(trade.sellerUserId, baseTokenIdentifier, -tradeQuantity.toNumber());
        const adjBuyerBase = await adjustBalance(trade.buyerUserId, baseTokenIdentifier, tradeQuantity.toNumber());
        const adjBuyerQuote = await adjustBalance(trade.buyerUserId, quoteTokenIdentifier, -tradeValue.toNumber());
        const adjSellerQuote = await adjustBalance(trade.sellerUserId, quoteTokenIdentifier, tradeValue.toNumber());

        if (!adjSellerBase || !adjBuyerBase || !adjBuyerQuote || !adjSellerQuote) {
          logger.error(`[MatchingEngine] CRITICAL: Balance adjustment failed for trade ${trade._id}.`);
          allUpdatesSuccessful = false;
        }
      }
    }

    for (const makerOrderId of matchOutput.removedMakerOrders) {
      await cache.updateOnePromise('orders', { _id: makerOrderId }, { $set: { status: OrderStatus.FILLED, updatedAt: new Date().toISOString() } });
    }
    if (matchOutput.updatedMakerOrder) {
      const { _id, filledQuantity, status } = matchOutput.updatedMakerOrder;
      await cache.updateOnePromise('orders', { _id }, { $set: { filledQuantity, status, updatedAt: new Date().toISOString() } });
    }

    let finalTakerStatus = takerOrder.status;
    if (new Decimal(takerOrder.filledQuantity).greaterThanOrEqualTo(takerOrder.quantity)) {
      finalTakerStatus = OrderStatus.FILLED;
    } else if (takerOrder.filledQuantity > 0) {
      finalTakerStatus = OrderStatus.PARTIALLY_FILLED;
    } else {
      finalTakerStatus = OrderStatus.OPEN;
    }

    takerOrder.status = finalTakerStatus;
    takerOrder.updatedAt = new Date().toISOString();
    if (trades.length > 0 && takerOrder.filledQuantity > 0) {
        let cumulativeValue = new Decimal(0);
        let totalQuantityFilled = new Decimal(0);
        trades.forEach(t => {
            if (t.takerOrderId === takerOrder._id) {
                cumulativeValue = cumulativeValue.plus(new Decimal(t.price).times(t.quantity));
                totalQuantityFilled = totalQuantityFilled.plus(t.quantity);
            }
        });
        if (totalQuantityFilled.greaterThan(0)) {
            // Ensure pairDetails is available here for tickSize precision
            const pricePrecision = pairDetails.tickSize.toString().split('.')[1]?.length || 2;
            takerOrder.averageFillPrice = cumulativeValue.dividedBy(totalQuantityFilled).toDP(pricePrecision).toNumber();
        }
        takerOrder.cumulativeQuoteValue = cumulativeValue.toNumber();
    }

    await cache.updateOnePromise('orders', { _id: takerOrder._id }, 
      { $set: { 
          status: takerOrder.status, 
          filledQuantity: takerOrder.filledQuantity, 
          averageFillPrice: takerOrder.averageFillPrice,
          cumulativeQuoteValue: takerOrder.cumulativeQuoteValue,
          updatedAt: takerOrder.updatedAt 
        } 
      });

    if (!allUpdatesSuccessful) {
        return { order: takerOrder, trades: trades, accepted: true, rejectReason: "Processed with some errors, check logs." };
    }
    
    logger.debug(`[MatchingEngine] Finished processing order ${takerOrder._id}. Final status: ${takerOrder.status}, Filled: ${takerOrder.filledQuantity}`);
    return { order: takerOrder, trades: trades, accepted: true };
  }

  public async cancelOrder(orderId: string, pairId: string, userId: string): Promise<boolean> {
    logger.debug(`[MatchingEngine] Received cancel request for order: ${orderId} on pair ${pairId} by user ${userId}`);
    const orderBook = await this._getOrderBook(pairId);
    if (!orderBook) {
      logger.error(`[MatchingEngine] Cannot cancel order ${orderId}: Order book for pair ${pairId} not found.`);
      return false;
    }

    const orderToCancel = await cache.findOnePromise('orders', { _id: orderId, userId: userId }) as Order | null;
    if (!orderToCancel) {
        logger.warn(`[MatchingEngine] Order ${orderId} not found for cancellation by user ${userId}.`);
        return false;
    }
    if (orderToCancel.status !== OrderStatus.OPEN && orderToCancel.status !== OrderStatus.PARTIALLY_FILLED) {
        logger.warn(`[MatchingEngine] Order ${orderId} is not in a cancellable state (${orderToCancel.status}).`);
        return false;
    }

    const removed = orderBook.removeOrder(orderId);
    if (removed) {
      // Assuming updateOnePromise returns a boolean indicating success
      const updatedInDb = await cache.updateOnePromise('orders', { _id: orderId }, { $set: { status: OrderStatus.CANCELLED, updatedAt: new Date().toISOString() } });
      if (!updatedInDb) {
          logger.error(`[MatchingEngine] CRITICAL: Order ${orderId} removed from book but FAILED to mark CANCELLED in DB.`);
          return false; // Or throw, this is a critical state
      }
      logger.debug(`[MatchingEngine] Order ${orderId} removed from book and marked CANCELLED.`);
      return true;
    } else {
      const currentOrderState = await cache.findOnePromise('orders', { _id: orderId }) as Order | null;
      if (currentOrderState && (currentOrderState.status === OrderStatus.FILLED || currentOrderState.status === OrderStatus.CANCELLED)) {
        logger.debug(`[MatchingEngine] Order ${orderId} already filled or cancelled in DB. Considered success for cancellation attempt.`);
        return true;
      }
      logger.warn(`[MatchingEngine] Failed to remove order ${orderId} from book. It might not have been found or already processed.`);
      return false;
    }
  }

  // ... other methods like getOrderBookSnapshot(pairId), getOrderStatus(orderId), etc.
}

export const matchingEngine = new MatchingEngine(); 