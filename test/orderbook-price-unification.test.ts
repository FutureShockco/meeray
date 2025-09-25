import assert from 'assert';
import { matchingEngine } from '../src/transactions/market/matching-engine.js';
import { setTokenDecimals } from '../src/utils/bigint.js';
import cache from '../src/cache.js';
import { OrderType, OrderSide, OrderStatus } from '../src/transactions/market/market-interfaces.js';

// Set up token decimals for test tokens
setTokenDecimals('BASE', 8);
setTokenDecimals('QUOTE', 8);

async function testUnifiedPriceCalculation() {
    // Arrange: create a pair and stub cache
    const pair = { _id: 'PAIR', baseAssetSymbol: 'BASE', quoteAssetSymbol: 'QUOTE', tickSize: '1', lotSize: '1', minNotional: '1', minTradeAmount: '1', maxTradeAmount: '1000000000' };
    const restoreFindOne = (cache as any).findOnePromise;
    (cache as any).findOnePromise = async (collection: string, query: any) => {
        if (collection === 'tradingPairs' && query._id === 'PAIR') return pair;
        return null;
    };
    // BUY trade: buying 100 BASE with 1000 QUOTE (price should be 10 QUOTE per BASE)
    const buyTrade = {
        _id: 'T1',
        pairId: 'PAIR',
        baseAssetSymbol: 'BASE',
        quoteAssetSymbol: 'QUOTE',
        side: 'BUY',
        quantity: '10000000000', // 100 BASE (8 decimals)
        total: '100000000000',   // 1000 QUOTE (8 decimals)
    };
    // SELL trade: selling 100 BASE for 1000 QUOTE (price should be 10 QUOTE per BASE)
    const sellTrade = {
        _id: 'T2',
        pairId: 'PAIR',
        baseAssetSymbol: 'BASE',
        quoteAssetSymbol: 'QUOTE',
        side: 'SELL',
        quantity: '10000000000', // 100 BASE
        total: '100000000000',   // 1000 QUOTE
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
    // Patch adjustUserBalance to no-op
    const restoreAdjust = (matchingEngine as any).adjustUserBalance;
    (matchingEngine as any).adjustUserBalance = async () => true;
    // Act: call addOrder
    const now = new Date().toISOString();
    const takerOrder = {
        _id: 'ORDER1',
        pairId: 'PAIR',
        baseAssetSymbol: 'BASE',
        quoteAssetSymbol: 'QUOTE',
        side: OrderSide.BUY,
        quantity: '10000000000',
        filledQuantity: '0',
        type: OrderType.LIMIT,
        status: OrderStatus.OPEN,
        userId: 'user',
        price: '100000000',
        createdAt: now,
        updatedAt: now,
    };
    const result = await matchingEngine.addOrder(takerOrder);
    // Assert: both trades should have price = 10 QUOTE per BASE (with 8 decimals: 100000000)
    for (const trade of result.trades) {
        assert.strictEqual(trade.price.toString(), '100000000');
    }
    // Restore
    (cache as any).findOnePromise = restoreFindOne;
    (matchingEngine as any)._getOrderBook = restoreOrderBook;
    (cache as any).insertOne = restoreInsert;
    (matchingEngine as any).adjustUserBalance = restoreAdjust;
    console.log('PASS - Unified price calculation for orderbook trades (BUY and SELL)');
}

testUnifiedPriceCalculation().catch(e => {
    console.error('FAIL - Unified price calculation test:', e);
    process.exitCode = 1;
});
