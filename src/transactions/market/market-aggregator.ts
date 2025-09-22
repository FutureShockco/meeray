import logger from '../../logger.js';
import cache from '../../cache.js';
import { HybridTradeData, LiquiditySource, HybridQuote, HybridRoute } from './market-interfaces.js';
import { LiquidityPoolData } from '../pool/pool-interfaces.js';
import { TradingPairData, OrderBookLevelData } from './market-interfaces.js';
import { toBigInt, getTokenDecimals } from '../../utils/bigint.js';

export class LiquidityAggregator {

  async getLiquiditySources(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
    const sources: LiquiditySource[] = [];

    try {
      // Get AMM pools
      const ammPools = await this.getAMMPools(tokenA, tokenB);
      sources.push(...ammPools);

      // Get orderbook pairs
      const orderbookSources = await this.getOrderbookSources(tokenA, tokenB);
      sources.push(...orderbookSources);

      return sources;
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting liquidity sources: ${error}`);
      return [];
    }
  }

  private async getAMMPools(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
    const pools: LiquiditySource[] = [];

    try {
      
      // Find pools containing both tokens
      const poolsData = await cache.findPromise('liquidityPools', {
        $or: [
          { tokenA_symbol: tokenA, tokenB_symbol: tokenB },
          { tokenA_symbol: tokenB, tokenB_symbol: tokenA }
        ]
      }) as LiquidityPoolData[];

      logger.debug(`[LiquidityAggregator] Found ${poolsData?.length || 0} pools in database`);

      for (const pool of poolsData || []) {
        const reserveA = toBigInt(pool.tokenA_reserve);
        const reserveB = toBigInt(pool.tokenB_reserve);
        const hasLiquidity = reserveA > 0n && reserveB > 0n;
        
        logger.debug(`[LiquidityAggregator] Pool ${pool._id}: ${pool.tokenA_symbol}(${reserveA})/${pool.tokenB_symbol}(${reserveB}) - Has liquidity: ${hasLiquidity}`);
        
        // Include pools even with 0 reserves for routing purposes
        // They can still be used for price discovery and routing
        pools.push({
          type: 'AMM',
          id: pool._id,
          tokenA: pool.tokenA_symbol,
          tokenB: pool.tokenB_symbol,
          reserveA: pool.tokenA_reserve,
          reserveB: pool.tokenB_reserve,
          hasLiquidity: hasLiquidity
        });
      }

      logger.debug(`[LiquidityAggregator] Found ${pools.length} AMM pools`);
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting AMM pools: ${error}`);
    }

    return pools;
  }

  /**
   * Get orderbook liquidity sources
   */
  private async getOrderbookSources(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
    const sources: LiquiditySource[] = [];

    try {
      // Find trading pairs
      const pairs = await cache.findPromise('tradingPairs', {
        $or: [
          { baseAssetSymbol: tokenA, quoteAssetSymbol: tokenB },
          { baseAssetSymbol: tokenB, quoteAssetSymbol: tokenA }
        ],
        status: 'TRADING'
      }) as TradingPairData[];

      logger.info(`[LiquidityAggregator] Found ${pairs?.length || 0} trading pairs for ${tokenA}/${tokenB}`);

      for (const pair of pairs || []) {
        logger.info(`[LiquidityAggregator] Checking pair ${pair._id} (${pair.baseAssetSymbol}/${pair.quoteAssetSymbol}) for orderbook depth`);
        // Get orderbook depth (you'll need to implement this based on your orderbook storage)
        const depth = await this.getOrderbookDepth(pair._id);

        if (depth && (depth.bidDepth > 0n || depth.askDepth > 0n)) {
          logger.info(`[LiquidityAggregator] Adding orderbook source for ${pair._id}: bidDepth=${depth.bidDepth}, askDepth=${depth.askDepth}`);
          sources.push({
            type: 'ORDERBOOK',
            id: pair._id,
            tokenA: pair.baseAssetSymbol,
            tokenB: pair.quoteAssetSymbol,
            bestBid: depth.bestBid,
            bestAsk: depth.bestAsk,
            bidDepth: depth.bidDepth,
            askDepth: depth.askDepth
          });
        } else {
          logger.info(`[LiquidityAggregator] NOT adding orderbook source for ${pair._id}: depth=${depth}, bidDepth=${depth?.bidDepth}, askDepth=${depth?.askDepth}`);
        }
      }

      logger.info(`[LiquidityAggregator] Found ${sources.length} orderbook sources`);
      sources.forEach((source, index) => {
        logger.info(`[LiquidityAggregator] Orderbook source ${index + 1}: ${source.id}, bestBid: ${source.bestBid}, bestAsk: ${source.bestAsk}, bidDepth: ${source.bidDepth}, askDepth: ${source.askDepth}`);
      });
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting orderbook sources: ${error}`);
    }

    return sources;
  }

  /**
   * Get best quote across all liquidity sources
   */
  async getBestQuote(tradeData: HybridTradeData): Promise<HybridQuote | null> {
    try {
      const sources = await this.getLiquiditySources(tradeData.tokenIn, tradeData.tokenOut);

      if (sources.length === 0) {
        logger.warn(`[LiquidityAggregator] No liquidity sources found for ${tradeData.tokenIn}/${tradeData.tokenOut}`);
        return null;
      }

      // Calculate quotes for each source
      const quotes = await Promise.all(
        sources.map(source => this.getQuoteFromSource(source, tradeData))
      );

      // Filter valid quotes
      const validQuotes = quotes.filter(q => q !== null);
      
      logger.info(`[LiquidityAggregator] Found ${validQuotes.length} valid quotes out of ${quotes.length} total sources`);
      validQuotes.forEach((quote, index) => {
        logger.info(`[LiquidityAggregator] Quote ${index + 1}: ${quote.type} - Output: ${quote.amountOut}, Price Impact: ${quote.priceImpact}`);
        if (quote.type === 'ORDERBOOK') {
          logger.info(`[LiquidityAggregator] Orderbook quote details: pairId=${quote.source.id}, side=${quote.route.details.side}, bestBid=${quote.source.bestBid}, bestAsk=${quote.source.bestAsk}`);
        }
      });

      if (validQuotes.length === 0) {
        logger.warn(`[LiquidityAggregator] No valid quotes found`);
        return null;
      }

      // Find optimal route combination
      return this.findOptimalRoute(validQuotes, tradeData);

    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting best quote: ${error}`);
      return null;
    }
  }

  /**
   * Get quote from a specific liquidity source
   */
  private async getQuoteFromSource(source: LiquiditySource, tradeData: HybridTradeData): Promise<any | null> {
    try {
      if (source.type === 'AMM') {
        return await this.getAMMQuote(source, tradeData);
      } else {
        return await this.getOrderbookQuote(source, tradeData);
      }
    } catch (error) {
      logger.debug(`[LiquidityAggregator] Error getting quote from ${source.type} source ${source.id}: ${error}`);
      return null;
    }
  }

  /**
   * Get quote from AMM pool
   */
  private async getAMMQuote(source: LiquiditySource, tradeData: HybridTradeData): Promise<any | null> {
    logger.debug(`[LiquidityAggregator] Processing AMM quote for pool ${source.id}: ${source.tokenA}/${source.tokenB}`);
    
    // Check if pool has liquidity
    if (!source.hasLiquidity) {
      logger.debug(`[LiquidityAggregator] Pool ${source.id} has no liquidity yet`);
      return null;
    }

    // Implement AMM quote calculation (similar to existing pool swap logic)
    const amountIn = toBigInt(tradeData.amountIn);

    // Determine token direction
    const tokenInIsA = source.tokenA === tradeData.tokenIn;
    const reserveIn = tokenInIsA ? toBigInt(source.reserveA!) : toBigInt(source.reserveB!);
    const reserveOut = tokenInIsA ? toBigInt(source.reserveB!) : toBigInt(source.reserveA!);

    logger.info(`[LiquidityAggregator] Pool ${source.id} reserves: ${reserveIn} ${source.tokenA}, ${reserveOut} ${source.tokenB}`);
    logger.info(`[LiquidityAggregator] Trade direction: ${tradeData.tokenIn} -> ${tradeData.tokenOut}, amountIn: ${amountIn}`);
    logger.info(`[LiquidityAggregator] Token direction: tokenInIsA=${tokenInIsA}, reserveIn=${reserveIn}, reserveOut=${reserveOut}`);

    // Additional safety check for reserves
    if (reserveIn <= 0n || reserveOut <= 0n) {
      logger.debug(`[LiquidityAggregator] Pool ${source.id} has insufficient reserves: ${reserveIn}/${reserveOut}`);
      return null;
    }

    // Check if the input amount is reasonable compared to reserves
    const inputRatio = Number(amountIn) / Number(reserveIn);
    if (inputRatio > 0.1) { // More than 10% of the pool
      logger.warn(`[LiquidityAggregator] Large trade detected: ${amountIn} is ${(inputRatio * 100).toFixed(2)}% of pool reserve ${reserveIn}. This may cause high slippage.`);
    }

    // Calculate output using constant product formula with fees (fixed 0.3% fee)
    const feeMultiplier = BigInt(9700); // 10000 - 300 = 9700 for 0.3% fee
    const feeDivisor = BigInt(10000);
    const amountInWithFee = (amountIn * feeMultiplier) / feeDivisor;
    
    if (amountInWithFee <= 0n) return null;
    
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    
    if (denominator === 0n) return null;
    
    const amountOut = numerator / denominator;

    // Calculate price impact
    const priceImpact = Number(amountIn) / Number(reserveIn);

    logger.info(`[LiquidityAggregator] Pool ${source.id} calculated output: ${amountOut} ${tradeData.tokenOut} for input: ${amountIn} ${tradeData.tokenIn}`);
    logger.info(`[LiquidityAggregator] Pool ${source.id} calculation details: amountInWithFee=${amountInWithFee}, numerator=${numerator}, denominator=${denominator}`);

    return {
      type: 'AMM',
      source,
      amountOut,
      priceImpact,
      route: {
        type: 'AMM',
        allocation: 100,
        details: { poolId: source.id }
      }
    };
  }

  /**
   * Get quote from orderbook
   */
  private async getOrderbookQuote(source: LiquiditySource, tradeData: HybridTradeData): Promise<any | null> {
    // Implement orderbook quote calculation
    const amountIn = toBigInt(tradeData.amountIn);
    
    logger.info(`[LiquidityAggregator] getOrderbookQuote called: source=${source.id}, amountIn=${amountIn}`);

    // Determine if we're buying or selling the base asset
    const isBuyingBase = source.tokenA === tradeData.tokenOut;
    
    // For orderbook quotes, we need to match against the opposite side
    // If we're buying MRY (base), we need to find someone selling MRY (ask side)
    // If we're selling MRY (base), we need to find someone buying MRY (bid side)
    const availableDepth = isBuyingBase ? source.askDepth! : source.bidDepth!;
    const price = isBuyingBase ? source.bestAsk! : source.bestBid!;
    
    logger.info(`[LiquidityAggregator] Orderbook depth selection: isBuyingBase=${isBuyingBase}, askDepth=${source.askDepth}, bidDepth=${source.bidDepth}, selectedDepth=${availableDepth}, selectedPrice=${price}`);
    
    logger.info(`[LiquidityAggregator] Orderbook matching: isBuyingBase=${isBuyingBase}, tradeData.tokenIn=${tradeData.tokenIn}, tradeData.tokenOut=${tradeData.tokenOut}, source.tokenA=${source.tokenA}, source.tokenB=${source.tokenB}`);
    logger.info(`[LiquidityAggregator] Orderbook liquidity: askDepth=${source.askDepth}, bidDepth=${source.bidDepth}, bestAsk=${source.bestAsk}, bestBid=${source.bestBid}`);

    if (toBigInt(availableDepth) < amountIn) {
      // Not enough liquidity
      logger.info(`[LiquidityAggregator] Not enough orderbook liquidity: availableDepth=${availableDepth}, amountIn=${amountIn}`);
      return null;
    }

    // Calculate output based on the orderbook price
    // Price is in quote per base (e.g., TESTS per MRY)
    const quoteDecimals = source.tokenB ? getTokenDecimals(source.tokenB) : 8;
    const baseDecimals = source.tokenA ? getTokenDecimals(source.tokenA) : 8;
    
    let amountOut: bigint;
    if (isBuyingBase) {
      // Buying base asset: amountOut = amountIn / price
      // amountIn is in quote units (TESTS), price is quote per base (TESTS per MRY)
      // So amountOut = amountIn / price (in base units - MRY)
      // Scale properly: amountOut = (amountIn * 10^baseDecimals) / price
      amountOut = (amountIn * BigInt(10 ** baseDecimals)) / toBigInt(price);
    } else {
      // Selling base asset: amountOut = amountIn * price
      // amountIn is in base units (MRY), price is quote per base (TESTS per MRY)
      // So amountOut = amountIn * price (in quote units - TESTS)
      // Scale properly: amountOut = (amountIn * price) / 10^baseDecimals
      amountOut = (amountIn * toBigInt(price)) / BigInt(10 ** baseDecimals);
    }
    
    logger.info(`[LiquidityAggregator] Orderbook quote calculation: isBuyingBase=${isBuyingBase}, amountIn=${amountIn}, price=${price}, quoteDecimals=${quoteDecimals}, baseDecimals=${baseDecimals}, amountOut=${amountOut}`);
    logger.info(`[LiquidityAggregator] Price formatting: raw price=${price}, formatted with quote decimals=${Number(price) / Math.pow(10, quoteDecimals)}, formatted with base decimals=${Number(price) / Math.pow(10, baseDecimals)}`);

    return {
      type: 'ORDERBOOK',
      source,
      amountOut,
      priceImpact: 0, // Minimal price impact for market orders
      route: {
        type: 'ORDERBOOK',
        allocation: 100,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        details: {
          pairId: source.id,
          side: isBuyingBase ? 'buy' : 'sell',
          price: price.toString()
        }
      }
    };
  }

  /**
   * Find optimal route combination
   */
  private findOptimalRoute(quotes: any[], tradeData: HybridTradeData): HybridQuote {
    // Compare all available quotes (AMM and orderbook) and pick the best one
    // This ensures users get the best price regardless of source
    const ammQuotes = quotes.filter(q => q.type === 'AMM');
    const orderbookQuotes = quotes.filter(q => q.type === 'ORDERBOOK');
    
    logger.debug(`[LiquidityAggregator] Available quotes: ${ammQuotes.length} AMM, ${orderbookQuotes.length} orderbook`);
    
    // Find the best quote across all sources (highest output = best price)
    const bestQuote = quotes.reduce((best, current) => {
      const currentOutput = toBigInt(current.amountOut);
      const bestOutput = toBigInt(best.amountOut);
      
      if (currentOutput > bestOutput) {
        logger.debug(`[LiquidityAggregator] Better quote found: ${current.type} with output ${currentOutput} vs ${bestOutput}`);
        return current;
      }
      return best;
    });
    
    logger.debug(`[LiquidityAggregator] Selected ${bestQuote.type} route with output: ${bestQuote.amountOut}`);
    if (bestQuote.type === 'ORDERBOOK') {
      logger.info(`[LiquidityAggregator] ORDERBOOK ROUTE SELECTED: pairId=${bestQuote.source.id}, side=${bestQuote.route.details.side}, bestBid=${bestQuote.source.bestBid}, bestAsk=${bestQuote.source.bestAsk}`);
    } else {
      logger.info(`[LiquidityAggregator] AMM ROUTE SELECTED: poolId=${bestQuote.source.id}`);
    }

    return {
      amountIn: tradeData.amountIn.toString(),
      amountOut: bestQuote.amountOut.toString(),
      amountOutFormatted: this.formatAmount(bestQuote.amountOut),
      priceImpact: bestQuote.priceImpact,
      priceImpactFormatted: `${(bestQuote.priceImpact * 100).toFixed(4)}%`,
      routes: [bestQuote.route]
    };
  }

  /**
   * Get orderbook depth for a trading pair
   */
  private async getOrderbookDepth(pairId: string): Promise<{
    bestBid: bigint;
    bestAsk: bigint;
    bidDepth: bigint;
    askDepth: bigint;
  } | null> {
    try {
      // This would query your orderbook storage
      // For now, return mock data - implement based on your orderbook storage structure
      const orders = await cache.findPromise('orders', {
        pairId,
        status: { $in: ['open', 'partially_filled'] }
      });

      logger.info(`[LiquidityAggregator] Found ${orders?.length || 0} open orders for pair ${pairId}`);

      if (!orders || orders.length === 0) {
        logger.info(`[LiquidityAggregator] No open orders found for pair ${pairId}`);
        return null;
      }

      // Calculate depth (simplified)
      const bids = orders.filter((o: any) => o.side === 'buy').sort((a: any, b: any) => {
        const priceA = toBigInt(b.price || '0');
        const priceB = toBigInt(a.price || '0');
        return priceA > priceB ? 1 : priceA < priceB ? -1 : 0;
      });
      const asks = orders.filter((o: any) => o.side === 'sell').sort((a: any, b: any) => {
        const priceA = toBigInt(a.price || '0');
        const priceB = toBigInt(b.price || '0');
        return priceA > priceB ? 1 : priceA < priceB ? -1 : 0;
      });

      const bestBid = bids.length > 0 ? toBigInt(bids[0].price || '0') : BigInt(0);
      const bestAsk = asks.length > 0 ? toBigInt(asks[0].price || '0') : BigInt(0);

      // Calculate available depth
      const bidDepth = bids.reduce((total: bigint, order: any) =>
        total + (toBigInt(order.quantity) - toBigInt(order.filledQuantity)), BigInt(0));
      const askDepth = asks.reduce((total: bigint, order: any) =>
        total + (toBigInt(order.quantity) - toBigInt(order.filledQuantity)), BigInt(0));

      logger.info(`[LiquidityAggregator] Orderbook depth for ${pairId}: bestBid=${bestBid}, bestAsk=${bestAsk}, bidDepth=${bidDepth}, askDepth=${askDepth}`);

      return { bestBid, bestAsk, bidDepth, askDepth };
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting orderbook depth: ${error}`);
      return null;
    }
  }

  /**
   * Format amount for display
   */
  private formatAmount(amount: bigint, tokenSymbol?: string): string {
    // Use 8 decimals as fallback if no symbol provided
    const decimals = tokenSymbol ? getTokenDecimals(tokenSymbol) : 8;
    return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
  }
}

// Export singleton instance
export const liquidityAggregator = new LiquidityAggregator();