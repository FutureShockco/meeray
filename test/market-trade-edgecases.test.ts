import assert from 'assert';
import cache from '../src/cache.js';
import { liquidityAggregator } from '../src/transactions/market/market-aggregator.js';

function stub(object: any, key: string, fn: any) {
    const orig = object[key];
    object[key] = fn;
    return () => (object[key] = orig);
}

const PAIR = { _id: 'PAIR_E', baseAssetSymbol: 'BASE', quoteAssetSymbol: 'QUOTE', tickSize: '10', lotSize: '5' };

async function main() {
    // Prevent global reads from being noisy
    const restoreFindPromise = stub(cache, 'findPromise', async (collection: string, query: any) => {
        if (collection === 'tradingPairs') return [PAIR];
        return [];
    });

    const marketTrade = await import('../src/transactions/market/market-trade.js');

    // Capture trade inserts globally for these tests
    const tradeInserts: any[] = [];
    let restoreInsert: () => void = () => {};

    // Test 1: Insufficient balance for ORDERBOOK buy
    {
        const restoreFindOne = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'tradingPairs' && query._id === 'PAIR_E') return PAIR;
            if (collection === 'accounts' && query.name === 'poor') return { name: 'poor', balances: { QUOTE: '50' } };
            return null;
        });

        marketTrade.__setTestHooks({ matchingEngine: { addOrder: async () => ({ accepted: true, trades: [] }) }, adjustUserBalance: async (u: any, t: any, a: any) => false });

        const data: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '1000', price: '1000000' };
        const res = await marketTrade.processTx(data, 'poor', 'tx-insufficient');
        assert.strictEqual(res, false, 'Expected processTx to fail due to insufficient balance/deduction failure');

        restoreFindOne();
        marketTrade.__setTestHooks({});
    }

    // Test 2: Slippage protection (minAmountOut) trips when combined routes underperform
    {
        // Make liquidityAggregator return an AMM quote that produces too little
        const origGetBest = liquidityAggregator.getBestQuote;
        (liquidityAggregator as any).getBestQuote = async () => ({ amountOut: '10', routes: [{ type: 'AMM', allocation: 100, details: { poolId: 'p1', hops: [] } }] });

        const data: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '1000', minAmountOut: '100000' };
        const res = await marketTrade.processTx(data, 'anyone', 'tx-slippage');
        assert.strictEqual(res, false, 'Expected processTx to return false due to slippage protection');

        (liquidityAggregator as any).getBestQuote = origGetBest;
    }

    // Test 3: Zero-liquidity pools are rejected in validation
    {
        // Make liquidityAggregator.getLiquiditySources return an AMM pool with zero reserves
        const origGetLiquidity = liquidityAggregator.getLiquiditySources;
        (liquidityAggregator as any).getLiquiditySources = async () => [ { type: 'AMM', id: 'zero', tokenA: 'BASE', tokenB: 'QUOTE', reserveA: '0', reserveB: '0', hasLiquidity: false } ];

        const data: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '100', }; // market order
        const res = await marketTrade.validateTx(data, 'user');
        assert.strictEqual(res, false, 'Expected validation to fail due to zero liquidity');

        (liquidityAggregator as any).getLiquiditySources = origGetLiquidity;
    }

    // Test 4: Tick/lot misalignment rejection
    {
        // Provide a trading pair with tickSize=10 and lotSize=5
        const restoreFindOne2 = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'tradingPairs' && query._id === 'PAIR_E') return PAIR;
            if (collection === 'accounts' && query.name === 'traderX') return { name: 'traderX', balances: { QUOTE: '1000000', BASE: '1000000' } };
            return null;
        });

        // Attempt to create an ORDERBOOK route with price/quantity not aligned
        const route = { type: 'ORDERBOOK', allocation: 100, details: { pairId: 'PAIR_E', side: 'BUY', orderType: 'LIMIT', price: '123', } };
        const data: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '1000', price: '123', routes: [route] };

        const res = await marketTrade.processTx(data, 'traderX', 'tx-align');
        assert.strictEqual(res, false, 'Expected processTx to reject misaligned tick/lot order');

        restoreFindOne2();
    }

    restoreFindPromise();
    console.log('Edge-case market-trade tests passed');
}

main().catch(e => {
    console.error('Edge-case tests runner error:', e);
    process.exitCode = 1;
});
