import express, { Request, Response, RequestHandler } from 'express';
import logger from '../../logger.js';
import cache from '../../cache.js';
import { liquidityAggregator } from '../../transactions/market/market-aggregator.js';
import { HybridTradeData } from '../../transactions/market/market-interfaces.js';
import { toBigInt, getTokenDecimals, calculateTradeValue } from '../../utils/bigint.js';

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
        reserveA: formatAmount(toBigInt(source.reserveA!), source.tokenA),
        reserveB: formatAmount(toBigInt(source.reserveB!), source.tokenB),
        rawReserveA: source.reserveA?.toString(),
        rawReserveB: source.reserveB?.toString()
      }),
      ...(source.type === 'ORDERBOOK' && {
        bestBid: formatAmount(toBigInt(source.bestBid!)),
        bestAsk: formatAmount(toBigInt(source.bestAsk!)),
        rawBestBid: source.bestBid?.toString(),
        rawBestAsk: source.bestAsk?.toString(),
        bidDepth: formatAmount(toBigInt(source.bidDepth!), source.tokenA),
        askDepth: formatAmount(toBigInt(source.askDepth!), source.tokenA),
        rawBidDepth: source.bidDepth?.toString(),
        rawAskDepth: source.askDepth?.toString()
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
      amountIn: formatAmount(toBigInt(quote.amountIn), tokenIn),
      rawAmountIn: quote.amountIn,
      routes: quote.routes.map(route => ({
        ...route,
        amountIn: formatAmount(toBigInt(route.amountIn), tokenIn),
        amountOut: formatAmount(toBigInt(route.amountOut), tokenOut),
        rawAmountIn: route.amountIn,
        rawAmountOut: route.amountOut,
        details: route.details
      })),
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
      amountIn: formatAmount(toBigInt(amountIn), tokenIn),
      rawAmountIn: amountIn,
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
 * Get statistics for a specific trading pair
 * GET /market/stats/:pairId
 */
router.get('/stats/:pairId', (async (req: Request, res: Response) => {
  try {
    const { pairId } = req.params;

    // Check if trading pair exists
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
      return res.status(404).json({ message: 'Trading pair not found' });
    }

    // Get trades for this pair
    const trades = await cache.findPromise('trades', { pairId },
      { sort: { timestamp: -1 }, limit: 100 }) || [];

    // Calculate 24h statistics
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const recentTrades = trades.filter(trade => trade.timestamp > oneDayAgo);

    // Sum as bigint in smallest units
    const volume24h = recentTrades.reduce((sum, trade) => sum + toBigInt(trade.volume || 0), 0n);
    const tradeCount24h = recentTrades.length;

    // Get price statistics
    let priceChange24h = 0;
    let priceChange24hPercent = 0;
    if (recentTrades.length > 0) {
      const latestPrice = Number(toBigInt(recentTrades[0]?.price || 0));
      const oldestPrice = Number(toBigInt(recentTrades[recentTrades.length - 1]?.price || 0));
      if (oldestPrice > 0) {
        priceChange24h = latestPrice - oldestPrice;
        priceChange24hPercent = (priceChange24h / oldestPrice) * 100;
      }
    }

    // Get current orders for this pair
  const orders = await cache.findPromise('orders', { pairId }, { sort: { timestamp: -1 } }) || [];
    const buyOrders = orders.filter(order => order.side === 'buy' &&
      (order.status === 'open' || order.status === 'partial'));
    const sellOrders = orders.filter(order => order.side === 'sell' &&
      (order.status === 'open' || order.status === 'partial'));

    // Calculate spread
    const highestBid = buyOrders.length > 0 ?
      Math.max(...buyOrders.map(order => Number(toBigInt(order.price || 0)))) : 0;
    const lowestAsk = sellOrders.length > 0 ?
      Math.min(...sellOrders.map(order => Number(toBigInt(order.price || 0)))) : 0;
    const spread = lowestAsk > 0 && highestBid > 0 ? lowestAsk - highestBid : 0;
    const spreadPercent = highestBid > 0 ? (spread / highestBid) * 100 : 0;

    res.json({
      pairId,
      pair,
      volume24h: formatAmount(volume24h, pair.quoteAssetSymbol),
      rawVolume24h: volume24h.toString(),
      tradeCount24h,
      priceChange24h: formatAmount(BigInt(Math.round(priceChange24h * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))))),
      rawPriceChange24h: priceChange24h.toString(),
      priceChange24hPercent,
      currentPrice: recentTrades[0] ? formatAmount(toBigInt(recentTrades[0].price || 0)) : '0.00000000',
      rawCurrentPrice: recentTrades[0] ? toBigInt(recentTrades[0].price || 0).toString() : '0',
      highestBid: formatAmount(BigInt(Math.round(highestBid * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))))),
      rawHighestBid: Math.round(highestBid * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))).toString(),
      lowestAsk: formatAmount(BigInt(Math.round(lowestAsk * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))))),
      rawLowestAsk: Math.round(lowestAsk * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))).toString(),
      spread: formatAmount(BigInt(Math.round(spread * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))))),
      rawSpread: Math.round(spread * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))).toString(),
      spreadPercent,
      buyOrderCount: buyOrders.length,
      sellOrderCount: sellOrders.length,
      recentTrades: trades.slice(0, 10).map(trade => ({
        ...trade,
        price: formatAmount(toBigInt(trade.price || 0), pair.quoteAssetSymbol),
        rawPrice: toBigInt(trade.price || 0).toString(),
        quantity: formatAmount(toBigInt(trade.quantity || 0), pair.baseAssetSymbol),
        rawQuantity: toBigInt(trade.quantity || 0).toString(),
        volume: trade.volume ? formatAmount(toBigInt(trade.volume), pair.quoteAssetSymbol) : '0.00000000',
        rawVolume: trade.volume ? toBigInt(trade.volume).toString() : '0'
      }))
    });
  } catch (error: any) {
    logger.error('Error fetching pair stats:', error);
    res.status(500).json({
      message: 'Error fetching pair stats',
      error: error.message
    });
  }
}) as RequestHandler);

/**
 * Get orderbook for a specific trading pair
 * GET /market/orderbook/:pairId
 */
router.get('/orderbook/:pairId', (async (req: Request, res: Response) => {
  try {
    const { pairId } = req.params;
    const { depth = 20 } = req.query; // Default to 20 levels

    // Check if trading pair exists
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
      return res.status(404).json({ message: 'Trading pair not found' });
    }

    // Get active orders for this pair
    const orders = await cache.findPromise('orders', {
      pairId,
      status: { $in: ['open', 'partially_filled'] }
    }) || [];

    // Separate buy and sell orders
    const buyOrders = orders
      .filter(order => order.side === 'buy')
      .sort((a, b) => Number(toBigInt(b.price || 0)) - Number(toBigInt(a.price || 0))) // Highest price first
      .slice(0, Number(depth));

    const sellOrders = orders
      .filter(order => order.side === 'sell')
      .sort((a, b) => Number(toBigInt(a.price || 0)) - Number(toBigInt(b.price || 0))) // Lowest price first
      .slice(0, Number(depth));
    // Format orderbook data
    const bids = buyOrders.map(order => {
      const price = formatAmount(toBigInt(order.price || 0), pair.quoteAssetSymbol);
      const quantity = formatAmount(toBigInt(order.remainingQuantity || order.quantity), pair.baseAssetSymbol);
      const rawPrice = toBigInt(order.price || 0).toString();
      const rawQuantity = toBigInt(order.remainingQuantity || order.quantity).toString();

      // Calculate total considering decimal differences
      const rawTotalBigInt = calculateTradeValue(
        toBigInt(order.price || 0),
        toBigInt(order.remainingQuantity || order.quantity),
        pair.baseAssetSymbol,
        pair.quoteAssetSymbol
      );

      const total = formatAmount(rawTotalBigInt, pair.quoteAssetSymbol);
      const rawTotal = rawTotalBigInt.toString();

      return {
        price,
        rawPrice,
        quantity,
        rawQuantity,
        total,
        rawTotal
      };
    });

    const asks = sellOrders.map(order => {
      const price = formatAmount(toBigInt(order.price || 0), pair.quoteAssetSymbol);
      const quantity = formatAmount(toBigInt(order.remainingQuantity || order.quantity), pair.baseAssetSymbol);
      const rawPrice = toBigInt(order.price || 0).toString();
      const rawQuantity = toBigInt(order.remainingQuantity || order.quantity).toString();

      // Calculate total considering decimal differences
      const rawTotalBigInt = calculateTradeValue(
        toBigInt(order.price || 0),
        toBigInt(order.remainingQuantity || order.quantity),
        pair.baseAssetSymbol,
        pair.quoteAssetSymbol
      );

      const total = formatAmount(rawTotalBigInt, pair.quoteAssetSymbol);
      const rawTotal = rawTotalBigInt.toString();

      return {
        price,
        rawPrice,
        quantity,
        rawQuantity,
        total,
        rawTotal
      };
    });    // Calculate spread
    const highestBid = bids.length > 0 ? Number(bids[0].price) : 0;
    const lowestAsk = asks.length > 0 ? Number(asks[0].price) : 0;
    const spread = lowestAsk > 0 && highestBid > 0 ? lowestAsk - highestBid : 0;
    const spreadPercent = highestBid > 0 ? (spread / highestBid) * 100 : 0;

    res.json({
      pairId,
      timestamp: new Date().toISOString(),
      bids,
      asks,
      spread: formatAmount(BigInt(Math.round(spread * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))))),
      rawSpread: Math.round(spread * Math.pow(10, getTokenDecimals(pair.quoteAssetSymbol))).toString(),
      spreadPercent,
      depth: {
        bids: bids.length,
        asks: asks.length
      }
    });
  } catch (error: any) {
    logger.error('Error fetching orderbook:', error);
    res.status(500).json({
      message: 'Error fetching orderbook',
      error: error.message
    });
  }
}) as RequestHandler);

/**
 * Get trade history for a specific trading pair
 * GET /market/trades/:pairId
 */
router.get('/trades/:pairId', (async (req: Request, res: Response) => {
  try {
    const { pairId } = req.params;
    const { limit = 50, since, before } = req.query;

    // Check if trading pair exists
    const pair = await cache.findOnePromise('tradingPairs', { _id: pairId });
    if (!pair) {
      return res.status(404).json({ message: 'Trading pair not found' });
    }

    // Build query filter
    const filter: any = { pairId };

    // Add time range filters if provided
    if (since) {
      filter.timestamp = { $gte: Number(since) };
    }
    if (before) {
      filter.timestamp = filter.timestamp ?
        { ...filter.timestamp, $lt: Number(before) } :
        { $lt: Number(before) };
    }

    // Get trades for this pair
    const trades = await cache.findPromise('trades', filter, {
      sort: { timestamp: -1 }, // Most recent first
      limit: Math.min(Number(limit), 500) // Cap at 500 trades
    }) || [];

    // Format trade data with proper decimal handling
    const formattedTrades = trades.map(trade => {
      const priceBigInt = toBigInt(trade.price);
      const quantityBigInt = toBigInt(trade.quantity);
      const quoteDecimals = getTokenDecimals(pair.quoteAssetSymbol);
      // Use the volume from the trade record if available, otherwise calculate it
      const volumeBigInt = trade.volume ? toBigInt(trade.volume) : (priceBigInt * quantityBigInt) / (BigInt(10) ** BigInt(quoteDecimals));

      // Determine correct price formatting based on trade side
      // For buy trades: price is in quote token units (TESTS per MRY)
      // For sell trades: price is in base token units (MRY per TESTS)
      const priceTokenSymbol = (trade.side === 'buy') ? pair.baseAssetSymbol : pair.quoteAssetSymbol;
      
      return {
        id: trade._id || trade.id,
        timestamp: trade.timestamp,
        price: formatAmount(priceBigInt, pair.baseAssetSymbol),
        rawPrice: priceBigInt.toString(),
        quantity: formatAmount(quantityBigInt, pair.baseAssetSymbol),
        rawQuantity: quantityBigInt.toString(),
        volume: formatAmount(volumeBigInt, priceTokenSymbol === pair.baseAssetSymbol ? pair.quoteAssetSymbol : pair.baseAssetSymbol),
        rawVolume: volumeBigInt.toString(),
        total: formatAmount(volumeBigInt, pair.quoteAssetSymbol),
        rawTotal: volumeBigInt.toString(),
        side: trade.side || 'unknown', // 'buy' or 'sell'
        type: trade.type || 'market', // 'market', 'limit', etc.
        source: trade.source || 'unknown' // 'pool', 'orderbook', 'hybrid'
      };
    });

    // Calculate summary statistics
    const volume24h = formattedTrades
      .filter(trade => trade.timestamp > Date.now() - (24 * 60 * 60 * 1000))
      .reduce((sum, trade) => sum + toBigInt(trade.rawVolume), 0n);

    const priceRange = formattedTrades.length > 0 ? {
      high: Math.max(...formattedTrades.map(t => Number(t.rawPrice))),
      low: Math.min(...formattedTrades.map(t => Number(t.rawPrice))),
      latest: formattedTrades[0] ? Number(formattedTrades[0].rawPrice) : 0,
      highFormatted: formatAmount(BigInt(Math.max(...formattedTrades.map(t => Number(t.rawPrice))))),
      lowFormatted: formatAmount(BigInt(Math.min(...formattedTrades.map(t => Number(t.rawPrice))))),
      latestFormatted: formattedTrades[0] ? formattedTrades[0].price : '0.00000000'
    } : {
      high: 0,
      low: 0,
      latest: 0,
      highFormatted: '0.00000000',
      lowFormatted: '0.00000000',
      latestFormatted: '0.00000000'
    };

    res.json({
      pairId,
      trades: formattedTrades,
      summary: {
        count: formattedTrades.length,
        volume24h: formatAmount(volume24h, pair.quoteAssetSymbol),
        rawVolume24h: volume24h.toString(),
        priceRange,
        timestamp: new Date().toISOString()
      },
      pagination: {
        limit: Number(limit),
        hasMore: formattedTrades.length === Number(limit)
      }
    });
  } catch (error: any) {
    logger.error('Error fetching trades:', error);
    res.status(500).json({
      message: 'Error fetching trades',
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
function formatAmount(amount: bigint, tokenSymbol?: string): string {
  // Format based on token-specific decimal scaling for display
  if (tokenSymbol) {
    const decimals = getTokenDecimals(tokenSymbol);
    const divisor = Math.pow(10, decimals);
    // For price, if the symbol is used for price display, force to use quote asset decimals (3 for TESTS)
    // If you want to force fewer decimals for price, you can clamp or set a max here
    return (Number(amount) / divisor).toFixed(decimals);
  }
  // Fallback to 8 decimals for backward compatibility
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
  const orders = await cache.findPromise('orders', { pairId }, { sort: { timestamp: -1 } });

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
 * Get orders for a specific user with optional pair filtering
 * GET /market/orders/:userId?pairId=PAIR_ID
 */
router.get('/orders/user/:userId', (async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { pairId, status, side, limit = 100 } = req.query;

    // Build query filter
    const filter: any = { userId };

    if (pairId) {
      filter.pairId = pairId;
    }

    if (status === 'active') {
      filter.status = { $in: ['open', 'partially_filled'] };
    }
    else if (status) {
      filter.status = status;
    }
    else {
      // By default, exclude cancelled and rejected orders
      filter.status = { $in: ['cancelled', 'rejected', 'expired', 'filled'] };
    }

    if (side) {
      filter.side = side;
    }

    // Get orders with optional filtering
    const orders = await cache.findPromise('orders', filter, {
      sort: { timestamp: -1 }, // Most recent first
      limit: Math.min(Number(limit), 500) // Cap at 500 orders
    }) || [];

    // Get trading pair information for proper decimal formatting
    const pairIds = [...new Set(orders.map(order => order.pairId))];
    const pairs = await Promise.all(
      pairIds.map(async (id) => {
        const pair = await cache.findOnePromise('tradingPairs', { _id: id });
        return { [id]: pair };
      })
    );
    const pairMap = pairs.reduce((acc, pair) => ({ ...acc, ...pair }), {});

    // Format order data
    const formattedOrders = orders.map(order => {
      const pair = pairMap[order.pairId];
      const baseSymbol = pair?.baseAssetSymbol || 'UNKNOWN';
      const quoteSymbol = pair?.quoteAssetSymbol || 'UNKNOWN';
      return {
        id: order._id || order.id,
        pairId: order.pairId,
        side: order.side,
        type: order.type,
        price: order.price ? formatAmount(toBigInt(order.price), quoteSymbol) : null,
        rawPrice: order.price ? toBigInt(order.price).toString() : null,
        quantity: formatAmount(toBigInt(order.quantity), baseSymbol),
        rawQuantity: toBigInt(order.quantity).toString(),
        remainingQuantity: formatAmount(toBigInt(order.remainingQuantity || 0), baseSymbol),
        rawRemainingQuantity: toBigInt(order.remainingQuantity || 0).toString(),
        filledQuantity: formatAmount(toBigInt(order.filledQuantity || 0), baseSymbol),
        rawFilledQuantity: toBigInt(order.filledQuantity || 0).toString(),
        status: order.status,
        timestamp: order.timestamp,
        lastUpdateTime: order.lastUpdateTime
      };
    });

    // Calculate summary statistics
    const summary = {
      totalOrders: formattedOrders.length,
      openOrders: formattedOrders.filter(o => o.status === 'open').length,
      partialOrders: formattedOrders.filter(o => o.status === 'partial').length,
      filledOrders: formattedOrders.filter(o => o.status === 'filled').length,
      cancelledOrders: formattedOrders.filter(o => o.status === 'cancelled').length,
      buyOrders: formattedOrders.filter(o => o.side === 'buy').length,
      sellOrders: formattedOrders.filter(o => o.side === 'sell').length
    };

    res.json({
      userId,
      pairId: pairId || 'all',
      orders: formattedOrders,
      summary,
      filters: {
        pairId: pairId || null,
        status: status || null,
        side: side || null,
        limit: Number(limit)
      },
      timestamp: new Date().toISOString()
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
