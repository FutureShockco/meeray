import assert from 'assert';
import { OrderSide, OrderType, OrderStatus } from '../src/transactions/market/market-interfaces.js';
import { matchingEngine } from '../src/transactions/market/matching-engine.js';
import { OrderBook } from '../src/transactions/market/orderbook.js';
import { setTokenDecimals, toBigInt } from '../src/utils/bigint.js';
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
    console.log('Running orderbook multi-fill integration-style test');

    const pairId = 'MRY_TESTS';

    // Prepare an in-memory order book with three maker SELL orders at ascending prices
    // Prices are integers representing quote decimals (TESTS has 3 decimals)
    const makerOrders = [
        { id: 'MKR_A', price: '1200', qtyMRY: 20n }, // 20 MRY
        { id: 'MKR_B', price: '1220', qtyMRY: 30n }, // 30 MRY
        { id: 'MKR_C', price: '1250', qtyMRY: 40n }, // 40 MRY -> will be partially consumed
    ];

    const orderBook = new OrderBook(pairId);

    for (const m of makerOrders) {
        const order = {
            _id: m.id,
            pairId,
            baseAssetSymbol: 'MRY',
            quoteAssetSymbol: 'TESTS',
            side: OrderSide.SELL,
            type: OrderType.LIMIT,
            status: OrderStatus.OPEN,
            userId: `maker-${m.id}`,
            price: m.price,
            // quantity must be in base smallest units (decimals = 8)
            quantity: (m.qtyMRY * 10n ** 8n).toString(),
            filledQuantity: '0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        } as any;
        orderBook.addOrder(order);
    }

    // Stub matchingEngine._getOrderBook
    const restoreGetOrderBook = (matchingEngine as any)._getOrderBook;
    (matchingEngine as any)._getOrderBook = async (p: string) => (p === pairId ? orderBook : null);

    // Stub cache and capture DB interactions
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
        if (collection === 'liquidityPools') return null;
        return null;
    });

    const originalInsertOne = (cache as any).insertOne;
    Object.defineProperty(cache, 'insertOne', {
        value: (collection: string, doc: any, cb: any) => {
            if (collection === 'trades') insertedTrades.push(doc);
            if (collection === 'orders') updatedOrders.push(doc);
            return cb(null, true);
        },
        writable: true,
        configurable: true,
    });

    const originalUpdate = (cache as any).updateOnePromise;
    Object.defineProperty(cache, 'updateOnePromise', {
        value: async (collection: string, query: any, update: any) => {
            updatedOrders.push({ collection, query, update });
            return true;
        },
        writable: true,
        configurable: true,
    });

    const origInsertMany = (cache as any).insertMany;
    (cache as any).insertMany = (collection: string, docs: any, cb: any) => cb(null, true);

    // Stub adjustUserBalance via test hooks
    const accountUtils = await import('../src/utils/account.js');
    accountUtils.__setTestHooks({
        adjustUserBalance: async (userId: string, token: string, amount: any) => {
            adjustCalls.push({ userId, token, amount: toBigInt(amount).toString() });
            return true;
        },
    });

    // Taker BUY order: wants 70 MRY (fills across 3 makers: 20 + 30 + 20)
    const takerQtyMRY = 70n;
    const takerQty = (takerQtyMRY * 10n ** 8n).toString();
    const takerOrder = {
        _id: 'TKR1',
        pairId,
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: OrderSide.BUY,
        type: OrderType.LIMIT,
        status: OrderStatus.OPEN,
        userId: 'taker-user',
        // buyer willing to pay up to highest maker price: use high value to match all
        price: '1300',
        quantity: takerQty,
        filledQuantity: '0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    } as any;

    const result = await matchingEngine.addOrder(takerOrder);

    assert.strictEqual(result.accepted, true, 'Taker order should be accepted');
    // Expect 3 trade events (two full, one partial)
    assert.ok(result.trades && result.trades.length === 3, `Expected 3 trades, got ${result.trades?.length}`);

    // Validate quantities: 20,30,20 MRY in smallest units
    const expectedQuantities = [20n, 30n, 20n].map(q => (q * 10n ** 8n).toString());
    let sum = 0n;
    for (let i = 0; i < 3; i++) {
        const tr = result.trades[i];
        assert.strictEqual(tr.quantity.toString(), expectedQuantities[i], `Trade ${i} quantity mismatch`);
        sum += toBigInt(tr.quantity);
    }

    // Sum must equal taker quantity
    assert.strictEqual(sum.toString(), toBigInt(takerQty).toString(), 'Sum of trade quantities should equal taker quantity');

    // Each trade should have the maker's price
    const expectedPrices = ['1200', '1220', '1250'].map(p => toBigInt(p).toString());
    for (let i = 0; i < 3; i++) {
        const tr = result.trades[i];
        assert.strictEqual(tr.price.toString(), expectedPrices[i], `Trade ${i} price mismatch`);
    }

    // Ensure adjustUserBalance was called for each trade (seller base, buyer base, seller quote, buyer quote)
    assert.ok(adjustCalls.length >= result.trades.length * 4, `Expected at least ${result.trades.length * 4} balance adjustments, got ${adjustCalls.length}`);

    console.log('PASS - orderbook multi-fill test (taker filled across 3 trades)');

    // === New assertions: verify DB update behavior for filled/partially-filled orders ===
    // Find updates that targeted orders collection
    const orderUpdates = updatedOrders.filter(u => u.collection === 'orders' || (u.query && u.query._id));

    // Fully filled makers (MKR_A, MKR_B) should have been marked FILLED
    const filledUpdates = orderUpdates.filter(u => u.update && u.update.$set && u.update.$set.status === OrderStatus.FILLED);
    const filledIds = filledUpdates.map(u => (u.query && u.query._id) || (u._id));
    assert.ok(filledIds.includes('MKR_A'), 'Expected MKR_A to be marked FILLED in DB updates');
    assert.ok(filledIds.includes('MKR_B'), 'Expected MKR_B to be marked FILLED in DB updates');

    // Partially filled maker MKR_C should have an update entry with remainingQuantity not equal to "0"
    const mkcUpdate = orderUpdates.find(u => u.query && u.query._id === 'MKR_C');
    assert.ok(mkcUpdate, 'Expected an update for MKR_C in DB updates');
    const remQty = mkcUpdate.update && mkcUpdate.update.$set && mkcUpdate.update.$set.remainingQuantity;
    assert.ok(remQty && remQty !== '0', `Expected MKR_C remainingQuantity to be non-zero, got ${remQty}`);

    // Taker order should be updated to FILLED
    const takerUpdate = orderUpdates.find(u => u.query && u.query._id === 'TKR1');
    assert.ok(takerUpdate, 'Expected taker order update in DB updates');
    assert.strictEqual(takerUpdate.update.$set.status, OrderStatus.FILLED, 'Expected taker order to be marked FILLED');

    // Cleanup / restore
    (matchingEngine as any)._getOrderBook = restoreGetOrderBook;
    (cache as any).insertOne = originalInsertOne;
    (cache as any).updateOnePromise = originalUpdate;
    (cache as any).insertMany = origInsertMany;
    restoreFindOne();
    accountUtils.__setTestHooks({});

    // Ensure process exits successfully
    process.exit(0);
}

main().catch(e => {
    console.error('FAIL - orderbook multi-fill test:', e);
    process.exitCode = 1;
});
