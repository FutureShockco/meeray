
import assert from 'assert';
import { matchingEngine } from '../src/transactions/market/matching-engine.js';
import { setTokenDecimals } from '../src/utils/bigint.js';
import cache from '../src/cache.js';
import { OrderType, OrderSide, OrderStatus } from '../src/transactions/market/market-interfaces.js';

// Use real tokens: MRY (8 decimals), TESTS (3 decimals)
setTokenDecimals('MRY', 8);
setTokenDecimals('TESTS', 3);

async function testUnifiedPriceCalculation() {

    // Patch cache.findOnePromise to return a fake trading pair
    const restoreFindOne = (cache as any).findOnePromise;
    (cache as any).findOnePromise = async (collection: string, query: any) => {
        if (collection === 'tradingPairs' && (query._id === 'MRY-TESTS' || query.pairId === 'MRY-TESTS')) {
            return {
                _id: 'MRY-TESTS',
                baseAssetSymbol: 'MRY',
                quoteAssetSymbol: 'TESTS',
                priceDecimals: 8,
                quantityDecimals: 8,
                minQuantity: '1',
                minPrice: '1',
                status: 'ACTIVE',
            };
        }
        return null;
    };
    // BUY trade: buying 100 MRY with 123.456 TESTS (price should be 1.23456 TESTS per MRY, 3 decimals)
    const buyTrade = {
        _id: 'T1',
        pairId: 'MRY-TESTS',
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: 'BUY',
        quantity: '10000000000', // 100 MRY (8 decimals)
        total: '123456',         // 123.456 TESTS (3 decimals)
    };
    // SELL trade: selling 100 MRY for 123.456 TESTS (price should be 1.23456 TESTS per MRY, 3 decimals)
    const sellTrade = {
        _id: 'T2',
        pairId: 'MRY-TESTS',
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: 'SELL',
        quantity: '10000000000', // 100 MRY (8 decimals)
        total: '123456',         // 123.456 TESTS (3 decimals)
    };
    // Patch orderBook.matchOrder to return our trades
    const restoreOrderBook = (matchingEngine as any)._getOrderBook;
    (matchingEngine as any)._getOrderBook = async () => ({
        matchOrder: () => ({
            trades: [buyTrade, sellTrade],
            takerOrderRemaining: null,
            removedMakerOrders: [],
        }),
        addOrder: () => {},
    });
    // Patch cache.insertOne to no-op
    const restoreInsert = (cache as any).insertOne;
    (cache as any).insertOne = (collection: string, doc: any, cb: any) => cb(null, true);
    // Patch cache.updateOne to no-op
    const restoreUpdate = (cache as any).updateOne;
    (cache as any).updateOne = (collection: string, query: any, update: any, cb: any) => cb(null, true);
    // Patch cache.insertMany to no-op
    const restoreInsertMany = (cache as any).insertMany;
    (cache as any).insertMany = (collection: string, docs: any, cb: any) => cb(null, true);
    // Patch adjustUserBalance to no-op
    const restoreAdjust = (matchingEngine as any).adjustUserBalance;
    (matchingEngine as any).adjustUserBalance = async () => true;
    // Act: call addOrder
    const now = new Date().toISOString();
    const takerOrder = {
        _id: 'ORDER1',
        pairId: 'MRY-TESTS',
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        side: OrderSide.BUY,
        quantity: '10000000000', // 100 MRY
        filledQuantity: '0',
        type: OrderType.LIMIT,
        status: OrderStatus.OPEN,
        userId: 'user',
        price: '1235', // 1.235 TESTS per MRY (3 decimals, rounded for test)
        createdAt: now,
        updatedAt: now,
    };
    const result = await matchingEngine.addOrder(takerOrder);
    // Assert: both trades should have price = 1235 (1.235 TESTS per MRY, 3 decimals, rounded)
    for (const trade of result.trades) {
        assert.strictEqual(trade.price.toString(), '1235');
    }
    // Restore
    (cache as any).findOnePromise = restoreFindOne;
    (matchingEngine as any)._getOrderBook = restoreOrderBook;
    (cache as any).insertOne = restoreInsert;
    (cache as any).updateOne = restoreUpdate;
    (cache as any).insertMany = restoreInsertMany;
    (matchingEngine as any).adjustUserBalance = restoreAdjust;
    console.log('PASS - Unified price calculation for orderbook trades (BUY and SELL) with MRY/TESTS');
}

testUnifiedPriceCalculation().catch(e => {
    console.error('FAIL - Unified price calculation test:', e);
    process.exitCode = 1;
});
