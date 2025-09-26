import { OrderData, TradeData, TradingPairData, OrderStatus, OrderType } from './market-interfaces.js';
import { OrderBook } from './orderbook.js';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString, calculateTradeValue, calculateDecimalAwarePrice } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import { generatePoolId } from '../../utils/pool.js';
import { chain } from '../../chain.js';
import { calculateFeeGrowthDelta } from '../../utils/fee-growth.js';

async function distributeOrderbookFeesToLiquidityProviders(
  baseAssetSymbol: string,
  quoteAssetSymbol: string,
  baseTokenFee: bigint,
  quoteTokenFee: bigint
): Promise<void> {
  try {
    const poolId = generatePoolId(baseAssetSymbol, quoteAssetSymbol);
    const pool = await cache.findOnePromise('liquidityPools', { _id: poolId });
    if (!pool) {
      logger.debug(`[MatchingEngine] No AMM pool found for ${baseAssetSymbol}_${quoteAssetSymbol}, orderbook fees burned`);
      return;
    }
    const totalLpTokens = toBigInt(pool.totalLpTokens);
    if (totalLpTokens <= 0n) {
      logger.debug(`[MatchingEngine] AMM pool ${poolId} has no LP tokens, orderbook fees burned`);
      return;
    }
    const poolTokens = new Set([pool.tokenA_symbol, pool.tokenB_symbol]);
    if (!poolTokens.has(baseAssetSymbol) || !poolTokens.has(quoteAssetSymbol)) {
      logger.warn(`[MatchingEngine] Pool ${poolId} tokens (${pool.tokenA_symbol}, ${pool.tokenB_symbol}) don't match trading pair (${baseAssetSymbol}, ${quoteAssetSymbol})`);
      return;
    }
    if (baseAssetSymbol === quoteAssetSymbol) {
      logger.warn(`[MatchingEngine] Cannot distribute fees for same-token pair: ${baseAssetSymbol}`);
      return;
    }
    let newFeeGrowthGlobalA = toBigInt(pool.feeGrowthGlobalA || '0');
    let newFeeGrowthGlobalB = toBigInt(pool.feeGrowthGlobalB || '0');
    if (baseTokenFee > 0n) {
      const feeGrowthDelta = calculateFeeGrowthDelta(baseTokenFee, baseAssetSymbol, totalLpTokens);
      if (pool.tokenA_symbol === baseAssetSymbol) {
        newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
      } else if (pool.tokenB_symbol === baseAssetSymbol) {
        newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
      } else {
        logger.error(`[MatchingEngine] Base token ${baseAssetSymbol} not found in pool ${poolId}`);
        return;
      }
    }
    if (quoteTokenFee > 0n) {
      const feeGrowthDelta = calculateFeeGrowthDelta(quoteTokenFee, quoteAssetSymbol, totalLpTokens);
      if (pool.tokenA_symbol === quoteAssetSymbol) {
        newFeeGrowthGlobalA = newFeeGrowthGlobalA + feeGrowthDelta;
      } else if (pool.tokenB_symbol === quoteAssetSymbol) {
        newFeeGrowthGlobalB = newFeeGrowthGlobalB + feeGrowthDelta;
      } else {
        logger.error(`[MatchingEngine] Quote token ${quoteAssetSymbol} not found in pool ${poolId}`);
        return;
      }
    }
    if (baseTokenFee > 0n || quoteTokenFee > 0n) {
      await cache.updateOnePromise('liquidityPools', { _id: poolId }, {
        $set: {
          feeGrowthGlobalA: toDbString(newFeeGrowthGlobalA),
          feeGrowthGlobalB: toDbString(newFeeGrowthGlobalB)
        }
      });
      logger.debug(`[MatchingEngine] Distributed orderbook fees to AMM pool ${poolId}: ${baseTokenFee} ${baseAssetSymbol}, ${quoteTokenFee} ${quoteAssetSymbol}`);
    }
  } catch (error) {
    logger.error(`[MatchingEngine] Error distributing orderbook fees: ${error}`);
  }
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
  private initializationPromise: Promise<void>;
  private isInitialized: boolean = false;
  // Deterministic reconciliation based on blockchain head block numbers
  // How many blocks between reconciliations (1 = every block). Must be >= 1.
  private reconcileEveryNBlocks: number = Math.max(1, parseInt(process.env.ORDERBOOK_RECONCILE_EVERY_BLOCKS || '1', 10));
  // How often to poll the chain head to detect new blocks (ms)
  private pollIntervalMs: number = Math.max(250, parseInt(process.env.ORDERBOOK_RECONCILE_POLL_MS || '1000', 10));
  private reconcileTimer: NodeJS.Timeout | null = null;
  private lastReconciledBlock: number = 0;
  private lastPairRebuiltBlock: Map<string, number> = new Map();
  // In-process locks to avoid concurrent rebuilds per-pair
  private pairReconcileLocks: Map<string, boolean> = new Map();

  constructor() {
    logger.trace('[MatchingEngine] Initializing...');
    this.orderBooks = new Map<string, OrderBook>();
    this.initializationPromise = this._initializeBooks().then(() => {
      // Start background reconciler after initial load
      try {
        this.startAutoReconcile();
      } catch (err) {
        logger.error('[MatchingEngine] Failed to start auto-reconcile:', err);
      }
    });
  }

  /**
   * Start periodic reconciliation loop which compares DB authoritative state
   * with in-memory order books and rebuilds books when discrepancies are found.
   */
  private startAutoReconcile(): void {
    if (this.reconcileTimer) return; // already running
    if (this.reconcileEveryNBlocks <= 0) {
      logger.info('[MatchingEngine] Auto-reconcile disabled (ORDERBOOK_RECONCILE_EVERY_BLOCKS <= 0)');
      return;
    }
    logger.debug(`[MatchingEngine] Starting deterministic auto-reconcile: poll=${this.pollIntervalMs}ms every ${this.reconcileEveryNBlocks} block(s)`);

    this.reconcileTimer = setInterval(async () => {
      try {
        // Read chain head deterministically. `chain` is available globally in this codebase.
        const head = (typeof chain !== 'undefined' && chain.getLatestBlock) ? chain.getLatestBlock() : null;
        if (!head || typeof head._id !== 'number') return; // can't determine head
        const headId = head._id as number;

        // Only reconcile once per target block that meets the modulus condition
        if (headId !== this.lastReconciledBlock && (headId % this.reconcileEveryNBlocks) === 0) {
          this.lastReconciledBlock = headId;
          logger.debug(`[MatchingEngine] Triggering reconcile at block ${headId}`);
          await this.reconcileAllPairs();
        }
      } catch (err) {
        logger.error('[MatchingEngine] Auto-reconcile error:', err);
      }
    }, this.pollIntervalMs) as unknown as NodeJS.Timeout;
  }

  /**
   * Stop the periodic reconciliation loop (used in tests/shutdown)
   */
  public stopAutoReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer as any);
      this.reconcileTimer = null;
      logger.debug('[MatchingEngine] Auto-reconcile stopped');
    }
  }

  /**
   * Reconcile all loaded pairs by comparing DB open orders vs in-memory snapshot.
   * If a mismatch is detected, the pair's in-memory book is rebuilt from DB.
   */
  private async reconcileAllPairs(): Promise<void> {
    const pairIds = Array.from(this.orderBooks.keys());
    for (const pairId of pairIds) {
      try {
        await this.reconcilePair(pairId);
      } catch (err) {
        logger.error(`[MatchingEngine] Error reconciling pair ${pairId}:`, err);
      }
    }
  }

  private async reconcilePair(pairId: string): Promise<void> {
    const orderBook = this.orderBooks.get(pairId);
    if (!orderBook) return;

    // Build in-memory price-level snapshot
    let inMemorySnapshot;
    try {
      inMemorySnapshot = orderBook.getSnapshot(1000); // large depth to include all levels
    } catch (err) {
      logger.error(`[MatchingEngine] Failed to get in-memory snapshot for ${pairId}:`, err);
      return;
    }

    // Build DB price-level snapshot
    const openOrdersDB = await cache.findPromise('orders', {
      pairId,
      status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
    }) as any[] | null;

    const dbPriceLevels = new Map<string, bigint>();
    if (openOrdersDB && openOrdersDB.length > 0) {
      for (const o of openOrdersDB) {
        try {
          const priceStr = o.price ? o.price.toString() : '0';
          const remaining = o.remainingQuantity ? toBigInt(o.remainingQuantity) : (toBigInt(o.quantity) - toBigInt(o.filledQuantity || '0'));
          if (remaining <= 0n) continue;
          dbPriceLevels.set(priceStr, (dbPriceLevels.get(priceStr) || 0n) + remaining);
        } catch (err) {
          logger.error(`[MatchingEngine] Error parsing DB order for pair ${pairId}:`, err);
        }
      }
    }

    // Compare DB levels vs in-memory with safeguards to avoid frequent/noisy rebuilds
    const inLevels = inMemorySnapshot.bids.concat(inMemorySnapshot.asks);

    // Fast-path: compare aggregate totals per side
    let memTotalBids = 0n;
    let memTotalAsks = 0n;
    for (const b of inMemorySnapshot.bids) memTotalBids += toBigInt(b.quantity);
    for (const a of inMemorySnapshot.asks) memTotalAsks += toBigInt(a.quantity);

    let dbTotalBids = 0n;
    let dbTotalAsks = 0n;
    // We need to infer side by price ordering: prices in DB map may be both bids & asks; use pair orders query to segregate
    // For simplicity, compute DB total across all open orders and compare to mem total across both sides
    for (const [, qty] of dbPriceLevels) {
      // We don't know side here; accumulate into a single total for quick equality test
      // We'll also compute combined mem total
    }
    const memCombined = memTotalBids + memTotalAsks;
    let dbCombined = 0n;
    for (const qty of dbPriceLevels.values()) dbCombined += toBigInt(qty);

    // If combined totals match exactly, assume no meaningful mismatch and skip rebuild
    if (dbCombined === memCombined) {
      // Still could be different distribution across price levels, but that's harmless for most UIs — avoid rebuild noise
      logger.trace(`[MatchingEngine] Reconcile check for ${pairId}: combined DB=${dbCombined} equals in-memory=${memCombined}. Skipping rebuild.`);
      return;
    }

    // Determine cooldown: avoid rebuilding the same pair repeatedly within a short block window
    const cooldownBlocks = Math.max(0, parseInt(process.env.ORDERBOOK_REBUILD_COOLDOWN_BLOCKS || '3', 10));
    const head = chain.getLatestBlock();
    const headId = head && typeof head._id === 'number' ? head._id : 0;
    const lastRebuilt = this.lastPairRebuiltBlock.get(pairId) || 0;
    if (headId - lastRebuilt <= cooldownBlocks) {
      logger.debug(`[MatchingEngine] Detected mismatch for ${pairId} but within cooldown (${headId - lastRebuilt} <= ${cooldownBlocks} blocks). Skipping rebuild.`);
      return;
    }

    // If we reached here, there is a combined total mismatch and cooldown passed — log details and rebuild
    logger.info(`[MatchingEngine] Detected orderbook mismatch for ${pairId}. DB combined=${dbCombined}, mem combined=${memCombined}. Rebuilding in-memory book from DB authoritative state.`);
    try {
      const rebuilt = new OrderBook(pairId);
      await this._loadOpenOrdersForPair(pairId, rebuilt);
      this.orderBooks.set(pairId, rebuilt);
      this.lastPairRebuiltBlock.set(pairId, headId);
      logger.debug(`[MatchingEngine] Successfully rebuilt order book for ${pairId} during reconciliation at block ${headId}.`);
    } catch (err) {
      logger.error(`[MatchingEngine] Failed to rebuild order book for ${pairId}:`, err);
    }
  }

  /**
   * Ensures the MatchingEngine is fully initialized before use
   */
  public async ensureInitialized(): Promise<void> {
    await this.initializationPromise;
  }

  /**
   * Checks if the MatchingEngine is ready for use
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  private async _initializeBooks(): Promise<void> {
    try {
      logger.trace('[MatchingEngine] Loading trading pairs and initializing order books...');

      const activePairsDB = await cache.findPromise('tradingPairs', { status: 'TRADING' }) as TradingPairData[] | null;

      if (!activePairsDB || activePairsDB.length === 0) {
        logger.warn('[MatchingEngine] No active trading pairs found to initialize.');
        this.isInitialized = true;
        return;
      }

      // Convert trading pair data
      const activePairs = activePairsDB.map(pairDB => ({
        ...pairDB,
        tickSize: toBigInt(pairDB.tickSize),
        lotSize: toBigInt(pairDB.lotSize),
        minNotional: toBigInt(pairDB.minNotional),
        minTradeAmount: toBigInt(pairDB.minTradeAmount),
        maxTradeAmount: toBigInt(pairDB.maxTradeAmount)
      }));

      // Initialize order books for each pair
      for (const pair of activePairs) {
        const orderBook = new OrderBook(pair._id);
        this.orderBooks.set(pair._id, orderBook);
        logger.debug(`[MatchingEngine] Initialized order book for pair ${pair._id}.`);

        // Load existing open orders
        await this._loadOpenOrdersForPair(pair._id, orderBook);
      }

      this.isInitialized = true;
      logger.debug('[MatchingEngine] Order books initialization completed.');

    } catch (error) {
      logger.error('[MatchingEngine] CRITICAL: Failed to initialize order books:', error);
      this.isInitialized = false;
      throw error; // Re-throw to let callers know initialization failed
    }
  }

  private async _loadOpenOrdersForPair(pairId: string, orderBook: OrderBook): Promise<void> {
    try {
      const openOrdersDB = await cache.findPromise('orders', {
        pairId: pairId,
        status: { $in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] }
      }) as OrderData[] | null;

      if (!openOrdersDB || openOrdersDB.length === 0) {
        logger.debug(`[MatchingEngine] No open orders found for pair ${pairId}.`);
        return;
      }

      logger.debug(`[MatchingEngine] Loading ${openOrdersDB.length} open orders for pair ${pairId}...`);

      let loadedCount = 0;
      for (const orderDB of openOrdersDB) {
        try {
          // Validate required fields
          if (!orderDB.price) {
            logger.warn(`[MatchingEngine] Skipping order ${orderDB._id}: missing price`);
            continue;
          }

          // Keep data as strings (consistent with your other code)
          const order: OrderData = {
            ...orderDB,
            // Keep string formats for consistency with OrderBook expectations
            price: orderDB.price.toString(),
            quantity: orderDB.quantity.toString(),
            filledQuantity: (orderDB.filledQuantity || '0').toString(),
            averageFillPrice: orderDB.averageFillPrice?.toString(),
            cumulativeQuoteValue: orderDB.cumulativeQuoteValue?.toString(),
            quoteOrderQty: orderDB.quoteOrderQty?.toString()
          };

          // Only add limit orders to the book (market orders don't persist)
          if (order.type === OrderType.LIMIT) {
            orderBook.addOrder(order);
            loadedCount++;
          }
        } catch (orderError) {
          logger.error(`[MatchingEngine] Error loading order ${orderDB._id}:`, orderError);
          // Continue with next order instead of failing entire initialization
        }
      }

      logger.debug(`[MatchingEngine] Successfully loaded ${loadedCount} orders for pair ${pairId}.`);

    } catch (error) {
      logger.error(`[MatchingEngine] Error loading orders for pair ${pairId}:`, error);
      throw error;
    }
  }
  private loadingPairs = new Set<string>(); // Track pairs currently being loaded

  private async _getOrderBook(pairId: string): Promise<OrderBook | null> {
    // Return existing order book if already loaded
    if (this.orderBooks.has(pairId)) {
      return this.orderBooks.get(pairId)!;
    }

    // Prevent concurrent loading of the same pair
    if (this.loadingPairs.has(pairId)) {
      // Wait a bit and try again (simple backoff)
      await new Promise(resolve => setTimeout(resolve, 100));
      return this._getOrderBook(pairId);
    }

    logger.warn(`[MatchingEngine] Order book for pair ${pairId} not found. Attempting to load...`);

    try {
      this.loadingPairs.add(pairId);

      const pairDB = await cache.findOnePromise('tradingPairs', { _id: pairId, status: 'TRADING' }) as TradingPairData | null;

      if (!pairDB) {
        logger.error(`[MatchingEngine] Could not find active trading pair ${pairId}.`);
        return null;
      }

      // Convert trading pair data
      const pair = {
        ...pairDB,
        tickSize: toBigInt(pairDB.tickSize),
        lotSize: toBigInt(pairDB.lotSize),
        minNotional: toBigInt(pairDB.minNotional),
        minTradeAmount: toBigInt(pairDB.minTradeAmount),
        maxTradeAmount: toBigInt(pairDB.maxTradeAmount)
      };

      // Create new order book
      const orderBook = new OrderBook(pair._id);

      // Load existing open orders (this was missing in your original)
      await this._loadOpenOrdersForPair(pair._id, orderBook);

      // Add to map after fully loaded
      this.orderBooks.set(pair._id, orderBook);

      logger.debug(`[MatchingEngine] Lazily initialized order book for pair ${pair._id} with existing orders.`);
      return orderBook;

    } catch (error) {
      logger.error(`[MatchingEngine] Error lazily loading order book for pair ${pairId}:`, error);
      return null;
    } finally {
      this.loadingPairs.delete(pairId);
    }
  }

  /**
   * Attempt to claim a reconcile for a pair at targetBlock using an atomic DB operation.
   * Returns true if this node should run reconcilePair(pairId).
   */
  /**
   * Ensure a pair is reconciled deterministically for the current reconcile target block.
   * Uses in-memory markers and a per-pair lock so no DB access is required.
   */
  private async ensurePairReconciled(pairId: string): Promise<void> {
    try {
      if (this.reconcileEveryNBlocks <= 0) return;
      const head = (typeof chain !== 'undefined' && chain.getLatestBlock) ? chain.getLatestBlock() : null;
      if (!head || typeof head._id !== 'number') return;
      const headId = head._id as number;
      // Only attempt reconcile on target blocks (same rule as auto-reconcile)
      if ((headId % this.reconcileEveryNBlocks) !== 0) return;
      const lastRebuiltForPair = this.lastPairRebuiltBlock.get(pairId) || 0;
      if (lastRebuiltForPair === headId) return; // already reconciled for this block
      if (this.pairReconcileLocks.get(pairId)) return; // someone else is reconciling this pair in-process
      this.pairReconcileLocks.set(pairId, true);
      try {
        logger.debug(`[MatchingEngine] Per-pair reconcile triggered for ${pairId} at block ${headId}`);
        await this.reconcilePair(pairId);
        this.lastPairRebuiltBlock.set(pairId, headId);
      } catch (err) {
        logger.error(`[MatchingEngine] Per-pair reconcile failed for ${pairId}:`, err);
      } finally {
        this.pairReconcileLocks.set(pairId, false);
      }
    } catch (err) {
      logger.error(`[MatchingEngine] ensurePairReconciled error for ${pairId}:`, err);
    }
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
      if (!pair._id) {
        logger.warn(`[MatchingEngine:warmupMarketData] Trading pair ID: ${pair._id} is invalid. Skipping.`);
        continue;
      }

      const orderBook = new OrderBook(pair._id);
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

  // eslint-disable-next-line max-lines-per-function
  public async addOrder(takerOrderInput: OrderData): Promise<EngineMatchResult> {
    const takerOrder = takerOrderInput;
    logger.debug(`[MatchingEngine] Received order ${takerOrder._id} for pair ${takerOrder.pairId}: ${takerOrder.side} ${takerOrder.quantity.toString()} ${takerOrder.baseAssetSymbol} @ ${takerOrder.price ? takerOrder.price.toString() : takerOrder.type}`);

    const orderBook = await this._getOrderBook(takerOrder.pairId);
    if (!orderBook) {
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const orderForDB = {
        ...finalOrderState,
        price: finalOrderState.price !== undefined ? toDbString(finalOrderState.price) : undefined,
        quantity: toDbString(finalOrderState.quantity),
        filledQuantity: toDbString(finalOrderState.filledQuantity),
        remainingQuantity: toDbString(toBigInt(finalOrderState.quantity) - toBigInt(finalOrderState.filledQuantity)),
        averageFillPrice: finalOrderState.averageFillPrice !== undefined ? toDbString(finalOrderState.averageFillPrice) : undefined,
        cumulativeQuoteValue: finalOrderState.cumulativeQuoteValue !== undefined ? toDbString(finalOrderState.cumulativeQuoteValue) : undefined,
        quoteOrderQty: finalOrderState.quoteOrderQty !== undefined ? toDbString(finalOrderState.quoteOrderQty) : undefined
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
        await cache.updateOnePromise('orders', { _id: takerOrder._id }, { $set: { status: OrderStatus.REJECTED, updatedAt: finalOrderState.updatedAt } });
      }
      return { order: finalOrderState, trades: [], accepted: false, rejectReason: `Trading pair ${takerOrder.pairId} not supported or inactive.` };
    }

    // Ensure the pair is reconciled for the current reconcile target block (in-memory gate)
    await this.ensurePairReconciled(takerOrder.pairId);

    const pairDetailsDB = await cache.findOnePromise('tradingPairs', { _id: takerOrder.pairId }) as TradingPairData | null;
    if (!pairDetailsDB) {
      logger.error(`[MatchingEngine] CRITICAL: Could not find pair details for order ${takerOrder._id}. Rejecting order.`);
      const finalOrderState = { ...takerOrder, status: OrderStatus.REJECTED, updatedAt: new Date().toISOString() };
      const orderForDB = {
        ...finalOrderState,
        price: finalOrderState.price !== undefined ? toDbString(finalOrderState.price) : undefined,
        quantity: toDbString(finalOrderState.quantity),
        filledQuantity: toDbString(finalOrderState.filledQuantity),
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
        await cache.updateOnePromise('orders', { _id: takerOrder._id }, { $set: { status: OrderStatus.REJECTED, updatedAt: finalOrderState.updatedAt } });
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
        price: takerOrder.price !== undefined ? toDbString(takerOrder.price) : undefined,
        quantity: toDbString(takerOrder.quantity),
        filledQuantity: toDbString(takerOrder.filledQuantity),
        remainingQuantity: toDbString(toBigInt(takerOrder.quantity) - toBigInt(takerOrder.filledQuantity)),
        averageFillPrice: takerOrder.averageFillPrice !== undefined ? toDbString(takerOrder.averageFillPrice) : undefined,
        cumulativeQuoteValue: takerOrder.cumulativeQuoteValue !== undefined ? toDbString(takerOrder.cumulativeQuoteValue) : undefined,
        quoteOrderQty: takerOrder.quoteOrderQty !== undefined ? toDbString(takerOrder.quoteOrderQty) : undefined
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
    try {
      // Log concise match output summary for debugging: removed makers, updated maker summary, and basic trade info
      const removed = Array.isArray(matchOutput.removedMakerOrders) ? matchOutput.removedMakerOrders : [];
      const updated = matchOutput.updatedMakerOrder ? { _id: matchOutput.updatedMakerOrder._id, filledQuantity: matchOutput.updatedMakerOrder.filledQuantity, status: matchOutput.updatedMakerOrder.status } : null;
      const tradeSummaries = (matchOutput.trades || []).map(t => ({ id: t._id, buyer: t.buyerUserId, seller: t.sellerUserId, quantity: t.quantity }));
      const safeStringify = (obj: any) => JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      logger.info(`[MatchingEngine] Match summary for taker ${takerOrder._id}: removedMakerOrders=${safeStringify(removed)}, updatedMaker=${safeStringify(updated)}, trades=${safeStringify(tradeSummaries)}`);
    } catch (logErr) {
      logger.warn('[MatchingEngine] Failed to log match summary:', logErr);
    }
    // Unify price calculation for all trades using calculateDecimalAwarePrice
    const tradesAppFormat: TradeData[] = matchOutput.trades.map(t => {
      // Determine trade side and assign base/quote symbols
      // For orderbook, t.side should be 'BUY' or 'SELL', and t.quantity is always in base asset
      const baseSymbol = t.baseAssetSymbol || pairDetails?.baseAssetSymbol;
      const quoteSymbol = t.quoteAssetSymbol || pairDetails?.quoteAssetSymbol;
      let price: bigint;
      if (t.side === 'BUY') {
        // Buying base, paying quote: price = quote per base
        price = calculateDecimalAwarePrice(toBigInt(t.total), toBigInt(t.quantity), quoteSymbol, baseSymbol);
      } else {
        // Selling base, receiving quote: price = quote per base
        price = calculateDecimalAwarePrice(toBigInt(t.total), toBigInt(t.quantity), quoteSymbol, baseSymbol);
      }
      return {
        ...t,
        price,
        quantity: toBigInt(t.quantity)
      };
    });

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
          price: toDbString(trade.price),
          quantity: toDbString(trade.quantity),
          feeAmount: trade.feeAmount !== undefined ? toDbString(trade.feeAmount) : undefined,
          makerFee: trade.makerFee !== undefined ? toDbString(trade.makerFee) : undefined,
          takerFee: trade.takerFee !== undefined ? toDbString(trade.takerFee) : undefined,
          total: toDbString(trade.total)
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
          price: toDbString(trade.price),
          quantity: toDbString(trade.quantity),
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
        const feeRate = toBigInt(150); // 0.15% in basis points for each party
        const feeDivisor = toBigInt(10000);

        // Calculate fees for both parties
        const baseTokenFee = (tradeQuantityBigInt * feeRate) / feeDivisor; // Fee on base token (taken from buyer)
        const quoteTokenFee = (tradeValue * feeRate) / feeDivisor; // Fee on quote token (taken from seller)

        // Apply trades with fees
        // Seller: loses base tokens, gains quote tokens minus fee
        // Buyer: gains base tokens minus fee, loses quote tokens
        const adjSellerBase = await adjustUserBalance(trade.sellerUserId, baseTokenIdentifier, -tradeQuantityBigInt);
        const adjBuyerBase = await adjustUserBalance(trade.buyerUserId, baseTokenIdentifier, tradeQuantityBigInt - baseTokenFee);
        const adjSellerQuote = await adjustUserBalance(trade.sellerUserId, quoteTokenIdentifier, tradeValue - quoteTokenFee);
        const adjBuyerQuote = await adjustUserBalance(trade.buyerUserId, quoteTokenIdentifier, -tradeValue);

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
      price: takerOrder.price ? toDbString(takerOrder.price) : 'MARKET',
      quantity: toDbString(takerOrder.quantity),
      baseAsset: pairDetails.baseAssetSymbol,
      quoteAsset: pairDetails.quoteAssetSymbol
    });

    for (const makerOrderId of matchOutput.removedMakerOrders) {
      try {
        // Ensure DB reflects the fully-filled state. Fetch existing order to determine its total quantity
        const makerOrderDB = await cache.findOnePromise('orders', { _id: makerOrderId }) as any | null;
        const filledQtyToPersist = makerOrderDB && makerOrderDB.quantity ? toDbString(makerOrderDB.quantity) : toDbString(0);
        try {
          const makerOrderDB = await cache.findOnePromise('orders', { _id: makerOrderId }) as any | null;
          // Log compact maker DB summary for debugging persistence issues
          try {
            logger.info(`[MatchingEngine] Maker DB read for ${makerOrderId}: quantity=${makerOrderDB && makerOrderDB.quantity ? makerOrderDB.quantity.toString() : 'MISSING'}, filledQuantity=${makerOrderDB && makerOrderDB.filledQuantity ? makerOrderDB.filledQuantity.toString() : '0'}, status=${makerOrderDB && makerOrderDB.status ? makerOrderDB.status : 'UNKNOWN'}`);
          } catch (logErr) {
            logger.warn(`[MatchingEngine] Failed to stringify maker DB read for ${makerOrderId}: ${logErr}`);
          }

          const filledQtyToPersist = makerOrderDB && makerOrderDB.quantity ? toDbString(makerOrderDB.quantity) : toDbString(0);

          const makerUpdateResult = await cache.updateOnePromise('orders', { _id: makerOrderId }, {
            $set: {
              status: OrderStatus.FILLED,
              filledQuantity: filledQtyToPersist,
              remainingQuantity: "0",
              updatedAt: new Date().toISOString()
            }
          });
          if (!makerUpdateResult) {
            logger.error(`[MatchingEngine] CRITICAL: updateOnePromise returned falsy when persisting FILLED state for maker order ${makerOrderId}`);
          } else {
            logger.info(`[MatchingEngine] Persisted FILLED state for maker order ${makerOrderId}`);
          }
        } catch (err) {
          logger.error(`[MatchingEngine] Failed to persist FILLED state for maker order ${makerOrderId}:`, err);
        }
      } catch (err) {
        logger.error(`[MatchingEngine] Failed to persist FILLED state for maker order ${makerOrderId}:`, err);
      }
    }

    if (matchOutput.updatedMakerOrder) {
      const { _id, filledQuantity, quantity, status, averageFillPrice, cumulativeQuoteValue } = matchOutput.updatedMakerOrder;
      const makerRemainingQuantity = toBigInt(quantity) - toBigInt(filledQuantity);
      const updateSet = {
        filledQuantity: toDbString(filledQuantity),
        remainingQuantity: toDbString(makerRemainingQuantity),
        status,
        averageFillPrice: averageFillPrice ? toDbString(averageFillPrice) : undefined,
        cumulativeQuoteValue: cumulativeQuoteValue ? toDbString(cumulativeQuoteValue) : undefined,
        updatedAt: new Date().toISOString()
      };
      try {
        const updatedMakerResult = await cache.updateOnePromise('orders', { _id }, { $set: updateSet });
        if (!updatedMakerResult) {
          logger.error(`[MatchingEngine] CRITICAL: updateOnePromise returned falsy when updating maker order ${_id}. updateSet=${JSON.stringify(updateSet)}`);
        } else {
          logger.info(`[MatchingEngine] Updated maker order ${_id} in DB`);
        }
      } catch (err) {
        logger.error(`[MatchingEngine] Error updating maker order ${_id}:`, err);
      }
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
      price: takerOrder.price !== undefined ? toDbString(takerOrder.price) : undefined,
      quantity: toDbString(takerOrder.quantity),
      filledQuantity: toDbString(takerOrder.filledQuantity),
      remainingQuantity: toDbString(remainingQuantity),
      averageFillPrice: takerOrder.averageFillPrice !== undefined ? toDbString(takerOrder.averageFillPrice) : undefined,
      cumulativeQuoteValue: takerOrder.cumulativeQuoteValue !== undefined ? toDbString(takerOrder.cumulativeQuoteValue) : undefined,
      quoteOrderQty: takerOrder.quoteOrderQty !== undefined ? toDbString(takerOrder.quoteOrderQty) : undefined
    };
    try {
      const takerUpdateResult = await cache.updateOnePromise('orders', { _id: takerOrder._id }, { $set: finalTakerOrderForDB });
      if (!takerUpdateResult) {
        logger.error(`[MatchingEngine] CRITICAL: updateOnePromise returned falsy when updating taker order ${takerOrder._id}. finalTakerOrderForDB=${JSON.stringify(finalTakerOrderForDB)}`);
      } else {
        logger.info(`[MatchingEngine] Persisted final taker order state for ${takerOrder._id}`);
      }
    } catch (err) {
      logger.error(`[MatchingEngine] Error persisting final taker order ${takerOrder._id}:`, err);
    }

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
        price: orderToCancel.price ? toDbString(orderToCancel.price) : 'MARKET',
        quantity: toDbString(orderToCancel.quantity),
        filledQuantity: toDbString(orderToCancel.filledQuantity),
        baseAsset: orderToCancel.baseAssetSymbol,
        quoteAsset: orderToCancel.quoteAssetSymbol
      });

      logger.debug(`[MatchingEngine] Order ${orderId} removed from book and marked CANCELLED.`);
      return true;
    } else {
      const currentOrderState = await cache.findOnePromise('orders', { _id: orderId }) as OrderData | null;
      if (currentOrderState && (currentOrderState.status === OrderStatus.FILLED || currentOrderState.status === OrderStatus.CANCELLED)) {
        logger.debug(`[MatchingEngine] Order ${orderId} already filled or cancelled in DB. In-memory removal may have failed; rebuilding order book for ${pairId} to remove stale entries.`);
        try {
          // Rebuild the in-memory book for this pair from DB authoritative state to remove any stale orders
          const rebuilt = new OrderBook(pairId);
          await this._loadOpenOrdersForPair(pairId, rebuilt);
          this.orderBooks.set(pairId, rebuilt);
          logger.debug(`[MatchingEngine] Rebuilt order book for ${pairId} after cancellation of ${orderId}.`);
        } catch (rebuildErr) {
          logger.error(`[MatchingEngine] Failed to rebuild order book for ${pairId}: ${rebuildErr}`);
        }
        return true;
      }
      logger.warn(`[MatchingEngine] Failed to remove order ${orderId} from book. It might not have been found or already processed.`);
      return false;
    }
  }
}

export const matchingEngine = new MatchingEngine();
