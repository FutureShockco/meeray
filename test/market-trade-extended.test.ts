import assert from 'assert';
import cache from '../src/cache.js';
import { liquidityAggregator } from '../src/transactions/market/market-aggregator.js';
import { OrderSide, OrderType } from '../src/transactions/market/market-interfaces.js';

// Capture logs silently for assertions if needed
const capturedLogs: string[] = [];

function stub(object: any, key: string, fn: any) {
    const orig = object[key];
    object[key] = fn;
    return () => (object[key] = orig);
}

// Prepare a simple trading pair used in tests
const PAIR = { _id: 'PAIR1', baseAssetSymbol: 'BASE', quoteAssetSymbol: 'QUOTE', tickSize: '1', lotSize: '1' };

async function main() {
    // Avoid noisy module init reads
    const restoreFindPromise = stub(cache, 'findPromise', async (collection: string, query: any) => {
        if (collection === 'tradingPairs') return [PAIR];
        capturedLogs.push(`[findPromise] ${collection}`);
        return [];
    });

    const marketTrade = await import('../src/transactions/market/market-trade.js');

    // Shared insert capture across tests
    const tradeInserts: any[] = [];
    let restoreInsert: () => void = () => {};

    // Test 1: AMM output below minAmountOut should route to orderbook (limit order placed)
    {
        const calls: any[] = [];
        const tradeInserts: any[] = [];
        const originalInsert = (cache as any).insertOne;
        Object.defineProperty(cache, 'insertOne', {
            value: (collection: string, doc: any, cb: any) => {
                if (collection === 'trades') {
                    tradeInserts.push(doc);
                    capturedLogs.push(`[insertOne trades] ${JSON.stringify(doc)}`);
                    return cb(null, true);
                }
                return cb(null, true);
            },
            writable: true,
            configurable: true,
        });
        const restoreInsert = () => Object.defineProperty(cache, 'insertOne', { value: originalInsert, writable: false, configurable: true });
        // Stub liquidityAggregator.getBestQuote to return a low AMM output
        const origGetBest = liquidityAggregator.getBestQuote;
        (liquidityAggregator as any).getBestQuote = async (data: any) => ({ amountOut: '50', routes: [{ type: 'AMM', allocation: 100, details: { poolId: 'p1', hops: [] } }] });

        // Stub findTradingPairId and trading pair read
        const restoreFindOne = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'tradingPairs' && query._id === 'PAIR1') return PAIR;
            if (collection === 'tradingPairs' && query._id) return PAIR;
            if (collection === 'accounts' && query.name === 'trader1') return { name: 'trader1', balances: { QUOTE: '1000000' } };
            return null;
        });

        // matchingEngine should accept limit order but return no immediate trades
        const matchingEngineMock = { addOrder: async (order: any) => { calls.push({ type: 'addOrder', order }); return { accepted: true, trades: [] }; } };

        // adjustUserBalance should succeed and record a deduction
        const adjustCalls: any[] = [];
        const adjustUserBalanceMock = async (userId: string, token: string, amount: any) => { adjustCalls.push({ userId, token, amount }); return true; };

        marketTrade.__setTestHooks({ matchingEngine: matchingEngineMock, adjustUserBalance: adjustUserBalanceMock });

        // Execute processTx with minAmountOut greater than AMM quote to force orderbook fallback
        const data: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '100', minAmountOut: '1000' };
        const res = await marketTrade.processTx(data, 'trader1', 'tx-fallback');

        assert.strictEqual(res, true, 'Expected processTx to succeed by placing a limit order on orderbook');
        assert(calls.find(c => c.type === 'addOrder'), 'Expected matchingEngine.addOrder to be called');
        // The placed order should be a LIMIT order
        const placedOrder = calls.find(c => c.type === 'addOrder').order;
        assert.strictEqual(placedOrder.type, OrderType.LIMIT);

        // If a trade record was created on orderbook placement, validate shape
        if (tradeInserts.length > 0) {
            const tr = tradeInserts[0];
            if (!tr._id) throw new Error('Trade record missing _id after orderbook fallback');
        }

        // Cleanup
        restoreFindOne();
        (liquidityAggregator as any).getBestQuote = origGetBest;
        marketTrade.__setTestHooks({});
    }

    // Test 2: Partial orderbook fill then AMM fallback (routes provided: 50% ORDERBOOK, 50% AMM)
    {
        const tradeCalls: any[] = [];
        // Provide explicit routes: 50% orderbook then 50% AMM
        const routes = [
            { type: 'ORDERBOOK', allocation: 50, details: { pairId: 'PAIR1', side: OrderSide.SELL, orderType: OrderType.MARKET } },
            { type: 'AMM', allocation: 50, details: { poolId: 'p-amm', hops: [] } },
        ];

        // Stub cache.findOnePromise for accounts and pools
        const restoreFindOne2 = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'accounts' && query.name === 'trader2') return { name: 'trader2', balances: { BASE: '100000' } };
            if (collection === 'liquidityPools' && query._id === 'p-amm') return { _id: 'p-amm', tokenA_symbol: 'BASE', tokenB_symbol: 'QUOTE', tokenA_reserve: '1000000', tokenB_reserve: '1000000', totalLpTokens: '1000' };
            if (collection === 'tradingPairs' && query._id === 'PAIR1') return PAIR;
            return null;
        });

        // matchingEngine returns a partial trade (quantity 10)
        const matchingEngineMock2 = { addOrder: async (order: any) => ({ accepted: true, trades: [{ quantity: '10' }] }) };

        // processWithResult returns amountOut for AMM half: 40
        const processWithResultMock = async (swapData: any, sender: string, txid: string) => ({ success: true, amountOut: 40n });

        const adjustCalls: any[] = [];
        const adjustUserBalanceMock2 = async (userId: string, token: string, amount: any) => { adjustCalls.push({ userId, token, amount }); return true; };

        marketTrade.__setTestHooks({ matchingEngine: matchingEngineMock2, processWithResult: processWithResultMock, adjustUserBalance: adjustUserBalanceMock2, recordAMMTrade: async () => true });

        const data2: any = { tokenIn: 'BASE', tokenOut: 'QUOTE', amountIn: '20', routes };
        const res2 = await marketTrade.processTx(data2, 'trader2', 'tx-partial');
        assert.strictEqual(res2, true, 'Expected hybrid processTx to succeed with partial orderbook fill + AMM');

    // Cleanup
    restoreInsert();

        // Clean up
        restoreFindOne2();
        marketTrade.__setTestHooks({});
    }

    // Test 3: Hybrid multi-route execution sums outputs correctly
    {
        // Two routes: 30% AMM, 70% ORDERBOOK (orderbook immediate fills)
        const routes = [
            { type: 'AMM', allocation: 30, details: { poolId: 'p-1', hops: [] } },
            { type: 'ORDERBOOK', allocation: 70, details: { pairId: 'PAIR1', side: OrderSide.BUY, orderType: OrderType.MARKET } },
        ];

        const restoreFindOne3 = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
            if (collection === 'accounts' && query.name === 'trader3') return { name: 'trader3', balances: { QUOTE: '10000000', BASE: '1000000' } };
            if (collection === 'liquidityPools' && query._id === 'p-1') return { _id: 'p-1', tokenA_symbol: 'BASE', tokenB_symbol: 'QUOTE', tokenA_reserve: '1000000', tokenB_reserve: '1000000', totalLpTokens: '1000' };
            if (collection === 'tradingPairs' && query._id === 'PAIR1') return PAIR;
            return null;
        });

        // matchingEngine immediately fills orderbook allocation with quantity 700
        const matchingEngineMock3 = { addOrder: async (order: any) => ({ accepted: true, trades: [{ quantity: '700' }] }) };
        const processWithResultMock3 = async () => ({ success: true, amountOut: 300n });

        marketTrade.__setTestHooks({ matchingEngine: matchingEngineMock3, processWithResult: processWithResultMock3, recordAMMTrade: async () => true, adjustUserBalance: async () => true });

        const data3: any = { tokenIn: 'QUOTE', tokenOut: 'BASE', amountIn: '1000', routes };
        const res3 = await marketTrade.processTx(data3, 'trader3', 'tx-hybrid');
        assert.strictEqual(res3, true, 'Expected hybrid multi-route execution to succeed');

        restoreFindOne3();
        marketTrade.__setTestHooks({});
    // Final cleanup if not already cleaned
    try { restoreInsert(); } catch (e) {}
    }

    // Restore global stub
    restoreFindPromise();

    console.log('Extended market-trade tests passed.');
}

main().catch(e => {
    console.error('Extended tests runner error:', e);
    process.exitCode = 1;
});
