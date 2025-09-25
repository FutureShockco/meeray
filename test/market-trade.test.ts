import assert from 'assert';
import { OrderSide } from '../src/transactions/market/market-interfaces.js';
import cache from '../src/cache.js';
import * as accountUtils from '../src/utils/account.js';
import { matchingEngine } from '../src/transactions/market/matching-engine.js';

// Reusable test trading pair used to simulate tradingPairs collection
const TEST_PAIR = { _id: 'PAIR', baseAssetSymbol: 'BASE', quoteAssetSymbol: 'QUOTE', tickSize: '1', lotSize: '1' };

function stub(object: any, key: string, fn: any) {
    const orig = object[key];
    object[key] = fn;
    return () => (object[key] = orig);
}

async function main() {
    // Ensure tradingPairs findPromise returns something before importing market-trade so module init is quiet
    const restoreFindPromiseGlobal = stub(cache, 'findPromise', async (collection: string, query: any) => {
        if (collection === 'tradingPairs') return [TEST_PAIR];
        return [];
    });

    const marketTrade = await import('../src/transactions/market/market-trade.js');

    // Lightweight test runner helper
    function it(desc: string, fn: () => Promise<void> | void) {
        try {
            const res = fn();
            if (res && typeof (res as any).then === 'function') {
                (res as any)
                    .then(() => console.log(`PASS - ${desc}`))
                    .catch((e: any) => {
                        console.error(`FAIL - ${desc}: ${e}`);
                        process.exitCode = 1;
                    });
            } else {
                console.log(`PASS - ${desc}`);
            }
        } catch (e) {
            console.error(`FAIL - ${desc}: ${e}`);
            process.exitCode = 1;
        }
    }

    it('calculate order quantity for buy orders correctly', async () => {
        // Arrange: pair and account
        const pair = { ...TEST_PAIR };

        // Stub cache.findOnePromise to return the pair and account
        const restoreFind = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'tradingPairs' && query._id === 'PAIR') return pair;
            if (collection === 'accounts' && query.name === 'trader') return { name: 'trader', balances: { QUOTE: '100000000' } };
            return null;
        });

        // Stub cache.updateOnePromise so adjustUserBalance (which calls cache.updateOnePromise) succeeds
        const updateCalls: any[] = [];
        const originalUpdate = (cache as any).updateOnePromise;
        Object.defineProperty(cache, 'updateOnePromise', {
            value: async (collection: string, query: any, update: any) => {
                updateCalls.push({ collection, query, update });
                return true;
            },
            writable: true,
            configurable: true,
        });
        const restoreUpdate = () => Object.defineProperty(cache, 'updateOnePromise', { value: originalUpdate, writable: false, configurable: true });

        // Inject matching engine mock via test hooks to avoid redefining imports
        marketTrade.__setTestHooks({
            matchingEngine: { addOrder: async (order: any) => ({ accepted: true, trades: [] }) },
            adjustUserBalance: async () => true,
        });
        const restoreMatching = () => marketTrade.__setTestHooks({});

        // Execute - give the tradeData a price too so logs don't show undefined
        const route: any = { type: 'ORDERBOOK', allocation: 100, details: { pairId: 'PAIR', side: OrderSide.BUY, price: '1000000' } };
        const res = await (marketTrade as any).executeOrderbookRoute(route, { tokenIn: 'QUOTE', tokenOut: 'BASE', price: '1000000' } as any, 5000000n, 'trader', 'txid');

        // Assert
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.amountOut.toString(), '0');

        // Restore
        restoreFind();
        restoreUpdate();
        restoreMatching();
    });

    it('executeAMMRoute returns swap result amount and records AMM trade', async () => {
        const swapAmountIn = 10000n;

        // Inject processWithResult and recordAMMTrade mocks via test hooks
        marketTrade.__setTestHooks({ processWithResult: async () => ({ success: true, amountOut: 7777n }), recordAMMTrade: async () => true, adjustUserBalance: async () => true });

        // Stub cache.findOnePromise for account and pool
        const restoreFind2 = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'accounts' && query.name === 'alice') return { name: 'alice', balances: { A: swapAmountIn.toString() } };
            if (collection === 'tokens') return { symbol: query && query.symbol ? query.symbol : 'TOK' };
            if (collection === 'liquidityPools' && query._id === 'pool1')
                return { _id: 'pool1', tokenA_symbol: 'A', tokenB_symbol: 'B', tokenA_reserve: '100000000', tokenB_reserve: '100000000', totalLpTokens: '1000000', feeGrowthGlobalA: '0', feeGrowthGlobalB: '0' };
            return null;
        });

        const route: any = { details: { poolId: 'pool1', hops: [] } };
        const result = await marketTrade.executeAMMRoute(route, { tokenIn: 'A', tokenOut: 'B', maxSlippagePercent: 1.0 } as any, swapAmountIn, 'alice', 'txid');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.amountOut.toString(), '7777');

        marketTrade.__setTestHooks({});
        restoreFind2();
    });

    // Restore global stubs
    restoreFindPromiseGlobal();
}

main().catch(e => {
    console.error('Test runner error:', e);
    process.exitCode = 1;
});
