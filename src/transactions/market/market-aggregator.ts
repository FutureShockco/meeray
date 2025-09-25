import cache from '../../cache.js';
import logger from '../../logger.js';
import { getTokenDecimals, toBigInt } from '../../utils/bigint.js';
import { generatePoolId } from '../../utils/pool.js';
import { LiquidityPoolData } from '../pool/pool-interfaces.js';
import { HybridQuote, HybridTradeData, LiquiditySource, TradingPairData } from './market-interfaces.js';

export class LiquidityAggregator {
    static TEST_HOOKS: any = {};
    static __setTestHooks(hooks: any) {
        Object.assign(LiquidityAggregator.TEST_HOOKS, hooks);
    }
    async getLiquiditySources(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
        const sources: LiquiditySource[] = [];
        try {
            if (LiquidityAggregator.TEST_HOOKS.getLiquiditySources) {
                return LiquidityAggregator.TEST_HOOKS.getLiquiditySources(tokenA, tokenB);
            }
            const ammPools = await this.getAMMPools(tokenA, tokenB);
            sources.push(...ammPools);
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
            const poolsData = (await cache.findPromise('liquidityPools', {
                $or: [
                    { tokenA_symbol: tokenA, tokenB_symbol: tokenB },
                    { tokenA_symbol: tokenB, tokenB_symbol: tokenA },
                ],
            })) as LiquidityPoolData[];
            logger.debug(`[LiquidityAggregator] Found ${poolsData?.length || 0} pools in database`);
            for (const pool of poolsData || []) {
                const reserveA = toBigInt(pool.tokenA_reserve);
                const reserveB = toBigInt(pool.tokenB_reserve);
                const hasLiquidity = reserveA > 0n && reserveB > 0n;
                pools.push({
                    type: 'AMM',
                    id: pool._id,
                    tokenA: pool.tokenA_symbol,
                    tokenB: pool.tokenB_symbol,
                    reserveA: pool.tokenA_reserve,
                    reserveB: pool.tokenB_reserve,
                    hasLiquidity: hasLiquidity,
                });
            }
            logger.debug(`[LiquidityAggregator] Found ${pools.length} AMM pools`);
        } catch (error) {
            logger.error(`[LiquidityAggregator] Error getting AMM pools: ${error}`);
        }
        return pools;
    }

    private async getOrderbookSources(tokenA: string, tokenB: string): Promise<LiquiditySource[]> {
        const sources: LiquiditySource[] = [];
        const pairId = generatePoolId(tokenA, tokenB);
        try {
            const pairs = (await cache.findPromise('tradingPairs', {
                _id: pairId,
                status: 'TRADING',
            })) as TradingPairData[];
            for (const pair of pairs || []) {
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
                    });
                } else {
                    logger.debug(
                        `[LiquidityAggregator] NOT adding orderbook source for ${pair._id}: depth=${depth}, bidDepth=${depth?.bidDepth}, askDepth=${depth?.askDepth}`
                    );
                }
            }
            logger.debug(`[LiquidityAggregator] Found ${sources.length} orderbook sources`);
        } catch (error) {
            logger.error(`[LiquidityAggregator] Error getting orderbook sources: ${error}`);
        }
        return sources;
    }

    async getBestQuote(tradeData: HybridTradeData): Promise<HybridQuote | null> {
        try {
            if (LiquidityAggregator.TEST_HOOKS.getBestQuote) {
                return LiquidityAggregator.TEST_HOOKS.getBestQuote(tradeData);
            }
            const sources = await this.getLiquiditySources(tradeData.tokenIn, tradeData.tokenOut);
            if (sources.length === 0) {
                logger.warn(`[LiquidityAggregator] No liquidity sources found for ${tradeData.tokenIn}/${tradeData.tokenOut}`);
                return null;
            }
            const quotes = await Promise.all(sources.map(source => this.getQuoteFromSource(source, tradeData)));
            const validQuotes = quotes.filter(q => q !== null);
            if (validQuotes.length === 0) {
                logger.warn(`[LiquidityAggregator] No valid quotes found`);
                return null;
            }
            return this.findOptimalRoute(validQuotes, tradeData);
        } catch (error) {
            logger.error(`[LiquidityAggregator] Error getting best quote: ${error}`);
            return null;
        }
    }

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

    private async getAMMQuote(source: LiquiditySource, tradeData: HybridTradeData): Promise<any | null> {
        logger.debug(`[LiquidityAggregator] Processing AMM quote for pool ${source.id}: ${source.tokenA}/${source.tokenB}`);
        if (!source.hasLiquidity) {
            logger.debug(`[LiquidityAggregator] Pool ${source.id} has no liquidity yet`);
            return null;
        }
        const amountIn = toBigInt(tradeData.amountIn);
        const tokenInIsA = source.tokenA === tradeData.tokenIn;
        const reserveIn = tokenInIsA ? toBigInt(source.reserveA!) : toBigInt(source.reserveB!);
        const reserveOut = tokenInIsA ? toBigInt(source.reserveB!) : toBigInt(source.reserveA!);
        logger.info(`[LiquidityAggregator] Pool ${source.id} reserves: ${reserveIn} ${source.tokenA}, ${reserveOut} ${source.tokenB}`);
        if (reserveIn <= 0n || reserveOut <= 0n) {
            logger.debug(`[LiquidityAggregator] Pool ${source.id} has insufficient reserves: ${reserveIn}/${reserveOut}`);
            return null;
        }
        const inputRatio = Number(amountIn) / Number(reserveIn);
        if (inputRatio > 0.1) {
            // More than 10% of the pool
            logger.warn(
                `[LiquidityAggregator] Large trade detected: ${amountIn} is ${(inputRatio * 100).toFixed(2)}% of pool reserve ${reserveIn}. This may cause high slippage.`
            );
        }

        // Calculate output using constant product formula with fees (fixed 0.3% fee)
        const feeMultiplier = toBigInt(9700); // 10000 - 300 = 9700 for 0.3% fee
        const feeDivisor = toBigInt(10000);
        const amountInWithFee = (amountIn * feeMultiplier) / feeDivisor;

        if (amountInWithFee <= 0n) return null;

        const numerator = amountInWithFee * reserveOut;
        const denominator = reserveIn + amountInWithFee;

        if (denominator === 0n) return null;

        const amountOut = numerator / denominator;

        // Calculate price impact
        const priceImpact = Number(amountIn) / Number(reserveIn);

        logger.info(
            `[LiquidityAggregator] Pool ${source.id} calculated output: ${amountOut} ${tradeData.tokenOut} for input: ${amountIn} ${tradeData.tokenIn}`
        );
        logger.info(
            `[LiquidityAggregator] Pool ${source.id} calculation details: amountInWithFee=${amountInWithFee}, numerator=${numerator}, denominator=${denominator}`
        );

        return {
            type: 'AMM',
            source,
            amountOut,
            priceImpact,
            route: {
                type: 'AMM',
                allocation: 100,
                details: { poolId: source.id },
            },
        };
    }

    /**
     * Get quote from orderbook
     */
    private async getOrderbookQuote(source: LiquiditySource, tradeData: HybridTradeData): Promise<any | null> {
        const amountIn = toBigInt(tradeData.amountIn);
        const isBuyingBase = source.tokenA === tradeData.tokenOut;

        // For orderbook quotes, we need to match against the opposite side
        // If we're buying MRY (base), we need to find someone selling MRY (ask side)
        // If we're selling MRY (base), we need to find someone buying MRY (bid side)
        const availableDepth = isBuyingBase ? source.askDepth! : source.bidDepth!;
        const price = isBuyingBase ? source.bestAsk! : source.bestBid!;

        logger.info(
            `[LiquidityAggregator] Orderbook depth selection: isBuyingBase=${isBuyingBase}, askDepth=${source.askDepth}, bidDepth=${source.bidDepth}, selectedDepth=${availableDepth}, selectedPrice=${price}`
        );

        logger.info(
            `[LiquidityAggregator] Orderbook matching: isBuyingBase=${isBuyingBase}, tradeData.tokenIn=${tradeData.tokenIn}, tradeData.tokenOut=${tradeData.tokenOut}, source.tokenA=${source.tokenA}, source.tokenB=${source.tokenB}`
        );
        logger.info(
            `[LiquidityAggregator] Orderbook liquidity: askDepth=${source.askDepth}, bidDepth=${source.bidDepth}, bestAsk=${source.bestAsk}, bestBid=${source.bestBid}`
        );

        if (toBigInt(availableDepth) < amountIn) {
            logger.warn(`[LiquidityAggregator] Not enough orderbook liquidity: availableDepth=${availableDepth}, amountIn=${amountIn}`);
            return null;
        }
        const quoteDecimals = source.tokenB ? getTokenDecimals(source.tokenB) : 8;
        const baseDecimals = source.tokenA ? getTokenDecimals(source.tokenA) : 8;

        let amountOut: bigint;
        if (isBuyingBase) {
            // Buying base asset: amountOut = amountIn / price
            // amountIn is in quote units (TESTS), price is quote per base (TESTS per MRY)
            // So amountOut = amountIn / price (in base units - MRY)
            // Scale properly: amountOut = (amountIn * 10^baseDecimals) / price
            amountOut = (amountIn * toBigInt(10 ** baseDecimals)) / toBigInt(price);
        } else {
            // Selling base asset: amountOut = amountIn * price
            // amountIn is in base units (MRY), price is quote per base (TESTS per MRY)
            // So amountOut = amountIn * price (in quote units - TESTS)
            // Scale properly: amountOut = (amountIn * price) / 10^baseDecimals
            amountOut = (amountIn * toBigInt(price)) / toBigInt(10 ** baseDecimals);
        }
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
                    side: isBuyingBase ? 'BUY' : 'SELL',
                    price: price.toString(),
                },
            },
        };
    }

    private findOptimalRoute(quotes: any[], tradeData: HybridTradeData): HybridQuote {
        const ammQuotes = quotes.filter(q => q.type === 'AMM');
        const orderbookQuotes = quotes.filter(q => q.type === 'ORDERBOOK');
        logger.debug(`[LiquidityAggregator] Available quotes: ${ammQuotes.length} AMM, ${orderbookQuotes.length} orderbook`);
        const bestQuote = quotes.reduce((best, current) => {
            const currentOutput = toBigInt(current.amountOut);
            const bestOutput = toBigInt(best.amountOut);
            if (currentOutput > bestOutput) {
                logger.debug(`[LiquidityAggregator] Better quote found: ${current.type} with output ${currentOutput} vs ${bestOutput}`);
                return current;
            }
            return best;
        });
        return {
            amountIn: tradeData.amountIn.toString(),
            amountOut: bestQuote.amountOut.toString(),
            amountOutFormatted: this.formatAmount(bestQuote.amountOut),
            priceImpact: bestQuote.priceImpact,
            priceImpactFormatted: `${(bestQuote.priceImpact * 100).toFixed(4)}%`,
            routes: [bestQuote.route],
        };
    }

    private async getOrderbookDepth(pairId: string): Promise<{
        bestBid: bigint;
        bestAsk: bigint;
        bidDepth: bigint;
        askDepth: bigint;
    } | null> {
        try {
            const orders = await cache.findPromise('orders', {
                pairId,
                status: { $in: ['OPEN', 'PARTIALLY_FILLED'] },
            });
            logger.info(`[LiquidityAggregator] Found ${orders?.length || 0} open orders for pair ${pairId}`);
            if (!orders || orders.length === 0) {
                logger.warn(`[LiquidityAggregator] No open orders found for pair ${pairId}`);
                return null;
            }
            const bids = orders
                .filter((o: any) => o.side === 'BUY')
                .sort((a: any, b: any) => {
                    const priceA = toBigInt(b.price || '0');
                    const priceB = toBigInt(a.price || '0');
                    return priceA > priceB ? 1 : priceA < priceB ? -1 : 0;
                });
            const asks = orders
                .filter((o: any) => o.side === 'SELL')
                .sort((a: any, b: any) => {
                    const priceA = toBigInt(a.price || '0');
                    const priceB = toBigInt(b.price || '0');
                    return priceA > priceB ? 1 : priceA < priceB ? -1 : 0;
                });

            const bestBid = bids.length > 0 ? toBigInt(bids[0].price || '0') : toBigInt(0);
            const bestAsk = asks.length > 0 ? toBigInt(asks[0].price || '0') : toBigInt(0);

            // Calculate available depth
            const bidDepth = bids.reduce((total: bigint, order: any) => total + (toBigInt(order.quantity) - toBigInt(order.filledQuantity)), toBigInt(0));
            const askDepth = asks.reduce((total: bigint, order: any) => total + (toBigInt(order.quantity) - toBigInt(order.filledQuantity)), toBigInt(0));
            return { bestBid, bestAsk, bidDepth, askDepth };
        } catch (error) {
            logger.error(`[LiquidityAggregator] Error getting orderbook depth: ${error}`);
            return null;
        }
    }

    private formatAmount(amount: bigint, tokenSymbol?: string): string {
        const decimals = tokenSymbol ? getTokenDecimals(tokenSymbol) : 8;
        return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
    }
}

export const liquidityAggregator = new LiquidityAggregator();
