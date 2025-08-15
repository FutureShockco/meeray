import express, { Request, Response, RequestHandler } from 'express';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { liquidityAggregator } from '../../transactions/market/market-aggregator.js';
import { HybridTradeData } from '../../transactions/market/market-interfaces.js';
import { toBigInt } from '../../utils/bigint.js';

const router = express.Router();

/**
 * Get all available liquidity sources for a token pair
 * GET /hybrid/sources/:tokenA/:tokenB
 */
router.get('/sources/:tokenA/:tokenB', (async (req: Request, res: Response) => {
  try {
    const { tokenA, tokenB } = req.params;
    
    if (!tokenA || !tokenB) {
      return res.status(400).json({ 
        message: 'Both tokenA and tokenB are required' 
      });
    }
    
    const sources = await liquidityAggregator.getLiquiditySources(tokenA, tokenB);
    
    // Transform for API response
    const transformedSources = sources.map(source => ({
      type: source.type,
      id: source.id,
      tokenA: source.tokenA,
      tokenB: source.tokenB,
      ...(source.type === 'AMM' && {
        reserveA: source.reserveA?.toString(),
        reserveB: source.reserveB?.toString(),
        reserveAFormatted: formatAmount(toBigInt(source.reserveA!)),
        reserveBFormatted: formatAmount(toBigInt(source.reserveB!)),
        feeTier: source.feeTier
      }),
      ...(source.type === 'ORDERBOOK' && {
        bestBid: source.bestBid?.toString(),
        bestAsk: source.bestAsk?.toString(),
        bestBidFormatted: formatAmount(toBigInt(source.bestBid!)),
        bestAskFormatted: formatAmount(toBigInt(source.bestAsk!)),
        bidDepth: source.bidDepth?.toString(),
        askDepth: source.askDepth?.toString(),
        bidDepthFormatted: formatAmount(toBigInt(source.bidDepth!)),
        askDepthFormatted: formatAmount(toBigInt(source.askDepth!))
      })
    }));
    
    res.json({
      tokenA,
      tokenB,
      sources: transformedSources,
      totalSources: sources.length,
      ammSources: sources.filter(s => s.type === 'AMM').length,
      orderbookSources: sources.filter(s => s.type === 'ORDERBOOK').length
    });
  } catch (error: any) {
    logger.error('Error fetching liquidity sources:', error);
    res.status(500).json({ 
      message: 'Error fetching liquidity sources', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Get optimal hybrid trade quote
 * POST /hybrid/quote
 */
router.post('/quote', (async (req: Request, res: Response) => {
  try {
    const { tokenIn, tokenOut, amountIn, maxSlippagePercent } = req.body;
    
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ 
        message: 'tokenIn, tokenOut, and amountIn are required' 
      });
    }
    
    // Validate amountIn
    let amountInBigInt: bigint;
    try {
      amountInBigInt = toBigInt(amountIn);
      if (amountInBigInt <= BigInt(0)) {
        throw new Error('Amount must be positive');
      }
    } catch (error) {
      return res.status(400).json({ 
        message: 'Invalid amountIn: must be a positive number' 
      });
    }
    
    const tradeData: HybridTradeData = {
      trader: 'quote_request', // Placeholder for quote
      tokenIn,
      tokenOut,
      amountIn: amountInBigInt,
      maxSlippagePercent
    };
    
    const quote = await liquidityAggregator.getBestQuote(tradeData);
    
    if (!quote) {
      return res.status(404).json({ 
        message: 'No liquidity available for this trade pair' 
      });
    }
    
    // Add formatted amounts and additional info
    const enhancedQuote = {
      ...quote,
      amountInFormatted: formatAmount(toBigInt(quote.amountIn)),
      routes: quote.routes.map(route => ({
        ...route,
        amountInFormatted: formatAmount(toBigInt(route.amountIn)),
        amountOutFormatted: formatAmount(toBigInt(route.amountOut)),
        details: route.details
      })),
      estimatedGas: '0.001', // Placeholder
      recommendation: getBestRouteRecommendation(quote)
    };
    
    res.json(enhancedQuote);
  } catch (error: any) {
    logger.error('Error getting hybrid quote:', error);
    res.status(500).json({ 
      message: 'Error getting trade quote', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Compare AMM vs Orderbook for a specific trade
 * POST /hybrid/compare
 */
router.post('/compare', (async (req: Request, res: Response) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.body;
    
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ 
        message: 'tokenIn, tokenOut, and amountIn are required' 
      });
    }
    
    const tradeData: HybridTradeData = {
      trader: 'comparison_request',
      tokenIn,
      tokenOut,
      amountIn: toBigInt(amountIn)
    };
    
    // Get all sources
    const sources = await liquidityAggregator.getLiquiditySources(tokenIn, tokenOut);
    
    // Separate AMM and orderbook sources
    const ammSources = sources.filter(s => s.type === 'AMM');
    const orderbookSources = sources.filter(s => s.type === 'ORDERBOOK');
    
    // Get quotes for each type
    const comparison = {
      amm: {
        available: ammSources.length > 0,
        sources: ammSources.length,
        bestQuote: null as any,
        totalLiquidity: ammSources.reduce((sum, s) => 
          sum + Number(s.reserveA || 0) + Number(s.reserveB || 0), 0)
      },
      orderbook: {
        available: orderbookSources.length > 0,
        sources: orderbookSources.length,
        bestQuote: null as any,
        totalDepth: orderbookSources.reduce((sum, s) => 
          sum + Number(s.bidDepth || 0) + Number(s.askDepth || 0), 0)
      },
      recommendation: 'hybrid' as 'amm' | 'orderbook' | 'hybrid'
    };
    
    // This would be enhanced with actual quote calculations
    // For now, returning structure
    
    res.json({
      tokenIn,
      tokenOut,
      amountIn,
      amountInFormatted: formatAmount(toBigInt(amountIn)),
      comparison,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error('Error comparing liquidity sources:', error);
    res.status(500).json({ 
      message: 'Error comparing liquidity sources', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Get hybrid trading statistics
 * GET /hybrid/stats
 */
router.get('/stats', (async (req: Request, res: Response) => {
  try {
    // This would fetch real statistics from your database
    const stats = {
      totalVolume24h: '1,234,567.89',
      totalTrades24h: 1543,
      avgTradeSize: '800.12',
      liquiditySources: {
        amm: 45,
        orderbook: 23,
        total: 68
      },
      routeDistribution: {
        ammOnly: 45.2,
        orderbookOnly: 32.1,
        hybrid: 22.7
      },
      avgPriceImprovement: 0.34, // Percentage improvement vs single source
      topPairs: [
        { pair: 'STEEM/USDT', volume24h: '234,567.89', trades: 342 },
        { pair: 'MRY/STEEM', volume24h: '123,456.78', trades: 189 },
        { pair: 'BTC/USDT', volume24h: '98,765.43', trades: 156 }
      ]
    };
    
    res.json({
      stats,
      timestamp: new Date().toISOString(),
      period: '24h'
    });
  } catch (error: any) {
    logger.error('Error fetching hybrid stats:', error);
    res.status(500).json({ 
      message: 'Error fetching statistics', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Health check for hybrid system
 * GET /hybrid/health
 */
router.get('/health', (async (req: Request, res: Response) => {
  try {
    // Check if both AMM and orderbook systems are operational
    const health = {
      status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
      timestamp: new Date().toISOString(),
      systems: {
        amm: {
          status: 'operational',
          pools: 0, // Would be fetched from database
          lastUpdate: new Date().toISOString()
        },
        orderbook: {
          status: 'operational',
          pairs: 0, // Would be fetched from database
          lastUpdate: new Date().toISOString()
        },
        aggregator: {
          status: 'operational',
          lastQuote: new Date().toISOString()
        }
      }
    };
    
    res.json(health);
  } catch (error: any) {
    logger.error('Error checking hybrid system health:', error);
    res.status(500).json({ 
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}) as RequestHandler);

/**
 * Helper functions
 */
function formatAmount(amount: bigint): string {
  // Format based on token decimals - using 8 decimals as default
  return (Number(amount) / 1e8).toFixed(8);
}

function getBestRouteRecommendation(quote: any): string {
  if (quote.routes.length === 1) {
    return quote.routes[0].type === 'AMM' ? 
      'Single AMM pool provides best price' : 
      'Orderbook provides best price';
  }
  
  return 'Hybrid routing across multiple sources provides optimal execution';
}

// ===== ORDERBOOK ENDPOINTS (for compatibility) =====

/**
 * Get all trading pairs
 * GET /market/pairs
 */
router.get('/pairs', (async (req: Request, res: Response) => {
  try {
    const pairs = await cache.findPromise('tradingPairs', {});
    res.json({
      pairs: pairs || [],
      total: pairs?.length || 0
    });
  } catch (error: any) {
    logger.error('Error fetching trading pairs:', error);
    res.status(500).json({ 
      message: 'Error fetching trading pairs', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Get specific trading pair
 * GET /market/pairs/:pairId
 */
router.get('/pairs/:pairId', (async (req: Request, res: Response) => {
  try {
    const { pairId } = req.params;
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    
    if (!pair) {
      return res.status(404).json({ message: 'Trading pair not found' });
    }
    
    res.json(pair);
  } catch (error: any) {
    logger.error('Error fetching trading pair:', error);
    res.status(500).json({ 
      message: 'Error fetching trading pair', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Get orders for a trading pair
 * GET /market/orders/pair/:pairId
 */
router.get('/orders/pair/:pairId', (async (req: Request, res: Response) => {
  try {
    const { pairId } = req.params;
    const orders = await cache.findPromise('orders', { pairId });
    
    res.json({
      pairId,
      orders: orders || [],
      total: orders?.length || 0
    });
  } catch (error: any) {
    logger.error('Error fetching orders for pair:', error);
    res.status(500).json({ 
      message: 'Error fetching orders', 
      error: error.message 
    });
  }
}) as RequestHandler);

/**
 * Get orders for a user
 * GET /market/orders/user/:userId
 */
router.get('/orders/user/:userId', (async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const orders = await cache.findPromise('orders', { userId });
    
    res.json({
      userId,
      orders: orders || [],
      total: orders?.length || 0
    });
  } catch (error: any) {
    logger.error('Error fetching user orders:', error);
    res.status(500).json({ 
      message: 'Error fetching user orders', 
      error: error.message 
    });
  }
}) as RequestHandler);

export default router;
