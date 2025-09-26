// Debug runner for executeOrderbookRoute
import { executeOrderbookRoute, __setTestHooks } from '../../src/transactions/market/market-trade.js';
import { toBigInt } from '../../src/utils/bigint.js';

// Minimal mocks for cache and matching engine
import cache from '../../src/cache.js';
import { OrderSide, OrderType } from '../../src/transactions/market/market-interfaces.js';

async function setupMocks() {
    // Mock trading pair
    await cache.insertOne('tradingPairs', {
        _id: 'MRY_TESTS',
        baseAssetSymbol: 'MRY',
        quoteAssetSymbol: 'TESTS',
        tickSize: '1',
        lotSize: '1',
    });

    // Mock account
    await cache.insertOne('accounts', {
        name: 'echelon-node1',
        balances: {
            MRY: '1000000000',
            TESTS: '1000000000'
        }
    });

    // Mock matching engine
    __setTestHooks({
        matchingEngine: {
            addOrder: async (order) => ({ accepted: true, trades: [{ quantity: order.quantity.toString(), price: order.price || '0' }] })
        }
    });
}

async function run() {
    await setupMocks();

    const routeBuy = {
        type: 'ORDERBOOK',
        allocation: 100,
        details: { pairId: 'MRY_TESTS', side: OrderSide.BUY, orderType: OrderType.LIMIT, price: '45000000' }
    };

    const tradeData = { tokenIn: 'TESTS', tokenOut: 'MRY', amountIn: '75000000', price: undefined };

    const res = await executeOrderbookRoute(routeBuy, tradeData, toBigInt('75000000'), 'echelon-node1', 'tx-debug');
    console.log('Buy result:', res);
}

run().catch(console.error);
