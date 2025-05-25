import { Order, Trade, TradingPair, OrderStatus, OrderSide, OrderType, OrderDB, TradingPairDB } from './market-interfaces.js';
import { OrderBook, OrderBookMatchResult } from './orderbook.js';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { adjustBalance } from '../../utils/account-utils.js';
import { BigIntMath, convertToBigInt, convertToString, toString, toBigInt } from '../../utils/bigint-utils.js';

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

const ORDER_NUMERIC_FIELDS: Array<keyof Order> = ['price', 'quantity', 'filledQuantity', 'averageFillPrice', 'cumulativeQuoteValue', 'quoteOrderQty'];
const TRADING_PAIR_NUMERIC_FIELDS: Array<keyof TradingPair> = ['tickSize', 'lotSize', 'minNotional', 'minTradeAmount', 'maxTradeAmount'];
const TRADE_NUMERIC_FIELDS: Array<keyof Trade> = ['price', 'quantity', 'feeAmount', 'makerFee', 'takerFee', 'total'];

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
    const activePairsDB = await cache.findPromise('tradingPairs', { status: 'TRADING' }) as TradingPairDB[] | null;

    if (!activePairsDB || activePairsDB.length === 0) {
      logger.warn('[MatchingEngine] No active trading pairs found to initialize.');
      // Ensure the final log reflects this outcome
      logger.debug('[MatchingEngine] Order books initialization skipped: No active pairs loaded.');
      return;
    }
    const activePairs = activePairsDB.map(pairDB => convertToBigInt<TradingPair>(pairDB, TRADING_PAIR_NUMERIC_FIELDS));

    for (const pair of activePairs) {
      const orderBook = new OrderBook(pair._id, pair.tickSize, pair.lotSize);
      this.orderBooks.set(pair._id, orderBook);
      logger.debug(`[MatchingEngine] Initialized order book for pair ${pair._id}.`);

      const openOrdersDB = await cache.findPromise('orders', {
        pairId: pair._id,
        status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
      }) as OrderDB[] | null;

      if (openOrdersDB && openOrdersDB.length > 0) {
        const openOrders = openOrdersDB.map(orderDB => convertToBigInt<Order>(orderDB, ORDER_NUMERIC_FIELDS));
        logger.debug(`[MatchingEngine] Loading ${openOrders.length} open orders for pair ${pair._id}...`);
        for (const order of openOrders) {
          if (order.type === OrderType.LIMIT) {
            orderBook.addOrder(order);
          }
        }
      }
    }
    logger.debug('[MatchingEngine] Order books initialization attempted (pair/order loading may be skipped due to missing cache.find).');
  }

  private async _getOrderBook(pairId: string): Promise<OrderBook | null> {
    if (this.orderBooks.has(pairId)) {
      return this.orderBooks.get(pairId)!;
    }
    logger.warn(`[MatchingEngine] Order book for pair ${pairId} not found. Attempting to load...`);
    const pairDB = await cache.findOnePromise('tradingPairs', { _id: pairId, status: 'TRADING'}) as TradingPairDB | null;
    if (pairDB) {
        const pair = convertToBigInt<TradingPair>(pairDB, TRADING_PAIR_NUMERIC_FIELDS);
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

  public async addOrder(takerOrderInput: Order): Promise<EngineMatchResult> {
    const takerOrder = takerOrderInput;
    logger.debug(`[MatchingEngine] Received order ${takerOrder._id} for pair ${takerOrder.pairId}: ${takerOrder.side} ${toString(takerOrder.quantity)} ${takerOrder.baseAssetSymbol} @ ${takerOrder.price ? toString(takerOrder.price) : takerOrder.type}`);
    
    const orderBook = await this._getOrderBook(takerOrder.pairId);
    if (!orderBook) {
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const orderForDB = convertToString<Order>(finalOrderState, ORDER_NUMERIC_FIELDS);
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

    const pairDetailsDB = await cache.findOnePromise('tradingPairs', {_id: takerOrder.pairId}) as TradingPairDB | null;
    if(!pairDetailsDB) {
        logger.error(`[MatchingEngine] CRITICAL: Could not find pair details for order ${takerOrder._id}. Rejecting order.`);
        const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
        const orderForDB = convertToString<Order>(finalOrderState, ORDER_NUMERIC_FIELDS);
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
    const pairDetails = convertToBigInt<TradingPair>(pairDetailsDB, TRADING_PAIR_NUMERIC_FIELDS);

    const existingOrderDB = await cache.findOnePromise('orders', { _id: takerOrder._id }) as OrderDB | null;
    if (!existingOrderDB) {
        const orderToInsertDB = convertToString<Order>(takerOrder, ORDER_NUMERIC_FIELDS);
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
    const tradesAppFormat: Trade[] = matchOutput.trades.map(t => ({...t, price: toBigInt(t.price), quantity: toBigInt(t.quantity)}));
    let allUpdatesSuccessful = true;

    if (tradesAppFormat.length > 0) {
      logger.debug(`[MatchingEngine] Order ${takerOrder._id} generated ${tradesAppFormat.length} trades.`);
      for (const trade of tradesAppFormat) {
        const tradeForDB = convertToString<Trade>(trade, TRADE_NUMERIC_FIELDS);
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
        
        const baseTokenIdentifier = `${pairDetails.baseAssetSymbol}@${pairDetails.baseAssetIssuer}`;
        const quoteTokenIdentifier = `${pairDetails.quoteAssetSymbol}@${pairDetails.quoteAssetIssuer}`;
        const tradeValue = BigIntMath.mul(trade.price, trade.quantity); // price and quantity are BigInt

        // Amounts for adjustBalance must be BigInt
        const adjSellerBase = await adjustBalance(trade.sellerUserId, baseTokenIdentifier, -trade.quantity);
        const adjBuyerBase = await adjustBalance(trade.buyerUserId, baseTokenIdentifier, trade.quantity);
        const adjSellerQuote = await adjustBalance(trade.sellerUserId, quoteTokenIdentifier, tradeValue);
        const adjBuyerQuote = await adjustBalance(trade.buyerUserId, quoteTokenIdentifier, -tradeValue);

        if (!adjSellerBase || !adjBuyerBase || !adjSellerQuote || !adjBuyerQuote) {
          logger.error(`[MatchingEngine] CRITICAL: Balance adjustment failed for trade ${trade._id}.`);
          allUpdatesSuccessful = false;
        }
      }
    }

    for (const makerOrderId of matchOutput.removedMakerOrders) {
      // Update with stringified BigInts potentially if status update also includes numeric fields
      await cache.updateOnePromise('orders', { _id: makerOrderId }, { $set: { status: OrderStatus.FILLED, updatedAt: new Date().toISOString() } });
    }
    if (matchOutput.updatedMakerOrder) {
      const { _id, filledQuantity, status, averageFillPrice, cumulativeQuoteValue } = matchOutput.updatedMakerOrder;
      const updateSet = {
        filledQuantity: toString(filledQuantity), 
        status,
        averageFillPrice: averageFillPrice ? toString(averageFillPrice) : undefined,
        cumulativeQuoteValue: cumulativeQuoteValue ? toString(cumulativeQuoteValue) : undefined,
        updatedAt: new Date().toISOString()
      };
      await cache.updateOnePromise('orders', { _id }, { $set: updateSet });
    }

    let finalTakerStatus = takerOrder.status;
    if (takerOrder.filledQuantity >= takerOrder.quantity) { // Both are BigInt
      finalTakerStatus = OrderStatus.FILLED;
    }
    // Note: PARTIALLY_FILLED status is set by orderBook.matchOrder directly on takerOrder if applicable

    takerOrder.status = finalTakerStatus;
    takerOrder.updatedAt = new Date().toISOString();
    if (tradesAppFormat.length > 0 && takerOrder.filledQuantity > BigInt(0)) {
        let cumulativeValue = BigInt(0);
        let totalQuantityFilled = BigInt(0);
        tradesAppFormat.forEach(t => {
            cumulativeValue = BigIntMath.add(cumulativeValue, BigIntMath.mul(t.price, t.quantity));
            totalQuantityFilled = BigIntMath.add(totalQuantityFilled, t.quantity);
        });
        if (totalQuantityFilled > BigInt(0)) {
            takerOrder.averageFillPrice = BigIntMath.div(cumulativeValue, totalQuantityFilled);
        }
        takerOrder.cumulativeQuoteValue = cumulativeValue; // This is already BigInt
    }

    const finalTakerOrderForDB = convertToString<Order>(takerOrder, ORDER_NUMERIC_FIELDS);
    await cache.updateOnePromise('orders', { _id: takerOrder._id }, { $set: finalTakerOrderForDB });

    if (!allUpdatesSuccessful) {
        return { order: takerOrder, trades: tradesAppFormat, accepted: true, rejectReason: "Processed with some errors, check logs." };
    }
    
    logger.debug(`[MatchingEngine] Finished processing order ${takerOrder._id}. Final status: ${takerOrder.status}, Filled: ${toString(takerOrder.filledQuantity)}`);
    return { order: takerOrder, trades: tradesAppFormat, accepted: true };
  }

  public async cancelOrder(orderId: string, pairId: string, userId: string): Promise<boolean> {
    logger.debug(`[MatchingEngine] Received cancel request for order: ${orderId} on pair ${pairId} by user ${userId}`);
    const orderBook = await this._getOrderBook(pairId);
    if (!orderBook) {
      logger.error(`[MatchingEngine] Cannot cancel order ${orderId}: Order book for pair ${pairId} not found.`);
      return false;
    }

    const orderToCancelDB = await cache.findOnePromise('orders', { _id: orderId, userId: userId }) as OrderDB | null;
    if (!orderToCancelDB) {
        logger.warn(`[MatchingEngine] Order ${orderId} not found for cancellation by user ${userId}.`);
        return false;
    }
    const orderToCancel = convertToBigInt<Order>(orderToCancelDB, ORDER_NUMERIC_FIELDS);

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