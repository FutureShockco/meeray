import logger from '../../logger.js';
import cache from '../../cache.js';
import { HybridTradeData, LiquiditySource, HybridQuote, HybridRoute } from './market-interfaces.js';
import { LiquidityPoolData } from '../pool/pool-interfaces.js';
import { TradingPairData, OrderBookLevelData } from './market-interfaces.js';
import { toBigInt } from '../../utils/bigint.js';

export class LiquidityAggregator {
  
  /**00
   * Get all available liquidity sources for a token pair
   */
  async getLiquiditySources(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
    const sources: LiquiditySource[] = [];
    
    try {
      // Get AMM pools
      const ammPools = await this.getAMMPools(tokenA, tokenB);
      sources.push(...ammPools);
      
      // Get orderbook pairs
      const orderbookSources = await this.getOrderbookSources(tokenA, tokenB);
      sources.push(...orderbookSources);
      
      logger.debug(`[LiquidityAggregator] Found ${sources.length} liquidity sources for ${tokenA}/${tokenB}`);
      return sources;
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting liquidity sources: ${error}`);
      return [];
    }
  }
  
  /**
   * Get AMM pool liquidity sources
   */
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
      
      for (const pool of poolsData || []) {
        if (toBigInt(pool.tokenA_reserve) > 0n && toBigInt(pool.tokenB_reserve) > 0n) {
          pools.push({
            type: 'AMM',
            id: pool._id,
            tokenA: pool.tokenA_symbol,
            tokenB: pool.tokenB_symbol,
            reserveA: pool.tokenA_reserve,
            reserveB: pool.tokenB_reserve,
            feeTier: pool.feeTier
          });
        }
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
      
      for (const pair of pairs || []) {
        // Get orderbook depth (you'll need to implement this based on your orderbook storage)
        const depth = await this.getOrderbookDepth(pair._id);
        
        if (depth && (depth.bidDepth > 0n || depth.askDepth > 0n)) {
          sources.push({
            type: 'ORDERBOOK',
            id: pair._id,
            tokenA: pair.baseAssetSymbol,
            tokenB: pair.quoteAssetSymbol,
            bestBid: depth.bestBid,
            bestAsk: depth.bestAsk,
            bidDepth: depth.bidDepth,
            askDepth: depth.askDepth,
            feeTier: 0 // Orderbook fees handled differently
          });
        }
      }
      
      logger.debug(`[LiquidityAggregator] Found ${sources.length} orderbook sources`);
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
    // Implement AMM quote calculation (similar to existing pool swap logic)
    const amountIn = toBigInt(tradeData.amountIn);
    
    // Determine token direction
    const tokenInIsA = source.tokenA === tradeData.tokenIn;
    const reserveIn = tokenInIsA ? toBigInt(source.reserveA!) : toBigInt(source.reserveB!);
    const reserveOut = tokenInIsA ? toBigInt(source.reserveB!) : toBigInt(source.reserveA!);
    
    // Calculate output using constant product formula with fees
    const feeTier = source.feeTier || 300; // Default 0.3%
    const amountInWithFee = amountIn * BigInt(10000 - feeTier);
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * BigInt(10000)) + amountInWithFee;
    const amountOut = numerator / denominator;
    
    // Calculate price impact
    const priceImpact = Number(amountIn) / Number(reserveIn);
    
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
    
    // Determine if we're buying or selling the base asset
    const isBuyingBase = source.tokenA === tradeData.tokenOut;
    const availableDepth = isBuyingBase ? source.askDepth! : source.bidDepth!;
    const price = isBuyingBase ? source.bestAsk! : source.bestBid!;
    
    if (toBigInt(availableDepth) < amountIn) {
      // Not enough liquidity
      return null;
    }
    
    // Calculate output (simplified - real implementation would walk the orderbook)
    const amountOut = isBuyingBase ? amountIn : (amountIn * toBigInt(price)) / BigInt(1e8); // Assuming 8 decimal precision
    
    return {
      type: 'ORDERBOOK',
      source,
      amountOut,
      priceImpact: 0, // Minimal price impact for market orders
      route: {
        type: 'ORDERBOOK',
        allocation: 100,
        details: { 
          pairId: source.id,
          side: isBuyingBase ? 'BUY' : 'SELL'
        }
      }
    };
  }
  
  /**
   * Find optimal route combination
   */
  private findOptimalRoute(quotes: any[], tradeData: HybridTradeData): HybridQuote {
    // For now, pick the best single route
    // TODO: Implement more sophisticated route splitting
    const bestQuote = quotes.reduce((best, current) => 
      toBigInt(current.amountOut) > toBigInt(best.amountOut) ? current : best
    );
    
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
        status: { $in: ['OPEN', 'PARTIALLY_FILLED'] }
      });
      
      if (!orders || orders.length === 0) {
        return null;
      }
      
      // Calculate depth (simplified)
      const bids = orders.filter((o: any) => o.side === 'BUY').sort((a: any, b: any) => {
        const priceA = toBigInt(b.price || '0');
        const priceB = toBigInt(a.price || '0');
        return priceA > priceB ? 1 : priceA < priceB ? -1 : 0;
      });
      const asks = orders.filter((o: any) => o.side === 'SELL').sort((a: any, b: any) => {
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
      
      return { bestBid, bestAsk, bidDepth, askDepth };
    } catch (error) {
      logger.error(`[LiquidityAggregator] Error getting orderbook depth: ${error}`);
      return null;
    }
  }
  
  /**
   * Format amount for display
   */
  private formatAmount(amount: bigint): string {
    // Implement based on your token precision requirements
    return (Number(amount) / 1e8).toFixed(8); // Assuming 8 decimal precision
  }
}

// Export singleton instance
export const liquidityAggregator = new LiquidityAggregator();
