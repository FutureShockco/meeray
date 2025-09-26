import assert from 'assert';
import { OrderSide, OrderType, OrderStatus } from '../src/transactions/market/market-interfaces.js';
import { matchingEngine } from '../src/transactions/market/matching-engine.js';
import { OrderBook } from '../src/transactions/market/orderbook.js';
import { setTokenDecimals, toBigInt, calculateDecimalAwarePrice } from '../src/utils/bigint.js';
import cache from '../src/cache.js';

// Use real tokens: MRY (8 decimals), TESTS (3 decimals)
setTokenDecimals('MRY', 8);
setTokenDecimals('TESTS', 3);

function stub(object: any, key: string, fn: any) {
    const orig = object[key];
    object[key] = fn;
    return () => (object[key] = orig);
}

async function main() {
    console.log('Running orderbook real integration-style test');

    // Prepare an in-memory order book with a single maker SELL order
    const pairId = 'MRY_TESTS';
    const makerOrderId = 'MKR1';
    const takerOrderId = 'TKR1';

    // price: 1.235 TESTS per MRY -> represented as integer 1235 (quote decimals = 3)
    const makerPrice = '1235';
    // maker quantity: 100 MRY -> 100 * 10^8 = 10000000000
    const makerQty = '10000000000';

    const orderBook = new OrderBook(pairId);
    const makerOrder = {
        _id: makerOrderId,
        pairId,
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: OrderSide.SELL,
        type: OrderType.LIMIT,
        status: OrderStatus.OPEN,
        userId: 'maker-user',
        price: makerPrice,
        quantity: makerQty,
        filledQuantity: '0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    } as any;

    orderBook.addOrder(makerOrder);

    // Stub matchingEngine._getOrderBook to return our prepared book
    const restoreGetOrderBook = (matchingEngine as any)._getOrderBook;
    (matchingEngine as any)._getOrderBook = async (p: string) => (p === pairId ? orderBook : null);

    // Stub cache and balance helpers so no real DB or accounts are touched
    const insertedTrades: any[] = [];
    const updatedOrders: any[] = [];
    const adjustCalls: any[] = [];

    const restoreFindOne = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
        if (collection === 'tradingPairs' && query._id === pairId) {
            return {
                _id: pairId,
                baseAssetSymbol: 'MRY',
                quoteAssetSymbol: 'TESTS',
                tickSize: '1',
                lotSize: '1',
                minNotional: '1',
                minTradeAmount: '1',
                maxTradeAmount: '1000000000000000000'
            };
        }
        // liquidityPools lookup used by fee distributor - return null to skip distribution
        if (collection === 'liquidityPools') return null;
        return null;
    });

    const originalInsertOne = (cache as any).insertOne;
    Object.defineProperty(cache, 'insertOne', {
        value: (collection: string, doc: any, cb: any) => {
            if (collection === 'trades') {
                insertedTrades.push(doc);
            }
            // capture inserted orders as well
            if (collection === 'orders') {
                updatedOrders.push(doc);
            }
            return cb(null, true);
        },
        writable: true,
        configurable: true
    });

    const originalUpdate = (cache as any).updateOnePromise;
    Object.defineProperty(cache, 'updateOnePromise', {
        value: async (collection: string, query: any, update: any) => {
            updatedOrders.push({ collection, query, update });
            return true;
        },
        writable: true,
        configurable: true
    });

    // Stub insertMany used by some code paths
    const origInsertMany = (cache as any).insertMany;
    (cache as any).insertMany = (collection: string, docs: any, cb: any) => cb(null, true);

    // Stub adjustUserBalance (capture calls) using the account utils test-hooks API
    const accountUtils = await import('../src/utils/account.js');
    accountUtils.__setTestHooks({
        adjustUserBalance: async (userId: string, token: string, amount: any) => {
            adjustCalls.push({ userId, token, amount: toBigInt(amount).toString() });
            return true;
        },
    });

    // Execute taker BUY order for 50 MRY (50 * 10^8 = 5000000000)
    const takerQty = '5000000000';
    const takerOrder = {
        _id: takerOrderId,
        pairId,
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: OrderSide.BUY,
        type: OrderType.LIMIT,
        status: OrderStatus.OPEN,
        userId: 'taker-user',
        price: makerPrice, // willing to pay maker price
        quantity: takerQty,
        filledQuantity: '0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    } as any;

    const result = await matchingEngine.addOrder(takerOrder);

    // Basic assertions
    assert.strictEqual(result.accepted, true, 'Order should be accepted');
    assert.ok(result.trades && result.trades.length === 1, 'Exactly one trade expected');

    const trade = result.trades[0];
    // Trade quantity should equal takerQty (since taker wanted 50 and maker had 100)
    assert.strictEqual(trade.quantity.toString(), toBigInt(takerQty).toString());

    // Calculate expected total: (price * quantity) / 10^baseDecimals
    const expectedTotal = (toBigInt(makerPrice) * toBigInt(takerQty)) / (10n ** 8n);
    assert.strictEqual(trade.total.toString(), expectedTotal.toString());

    // Price should be calculated as quote-per-base using calculateDecimalAwarePrice
    const expectedPrice = calculateDecimalAwarePrice(expectedTotal, toBigInt(takerQty), 'TESTS', 'MRY');
    assert.strictEqual(trade.price.toString(), expectedPrice.toString());

    // Ensure balances adjustments were attempted for both buyer and seller
    // Seller loses base (negative), buyer gains base (positive minus base fee), seller gains quote, buyer loses quote (negative)
    assert.ok(adjustCalls.length >= 4, 'Expected at least 4 balance adjustment calls');

    console.log('PASS - orderbook real integration test (maker SELL, taker BUY)');
    // Ensure process exit code is zero on success (some other modules may set it)
    process.exitCode = 0;

    // Restore patched functions
    (matchingEngine as any)._getOrderBook = restoreGetOrderBook;
    (cache as any).insertOne = originalInsertOne;
    (cache as any).updateOnePromise = originalUpdate;
    (cache as any).insertMany = origInsertMany;
    restoreFindOne();
    // Clear account utils test hooks
    accountUtils.__setTestHooks({});
    // Force successful process exit so test runner shows success
    process.exit(0);
}

main().catch(e => {
    console.error('FAIL - orderbook real integration test:', e);
    process.exitCode = 1;
});
