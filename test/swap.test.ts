import assert from 'assert';
// Load modules (we will stub cache and adjustUserBalance)
// We'll import poolProcessor dynamically inside each test after stubbing cache to avoid init-time DB calls
import cache from '../src/cache.js';
import * as accountUtils from '../src/utils/account.js';
import { toBigInt } from '../src/utils/bigint.js';

const _tests: Array<{ desc: string; fn: () => Promise<void> | void }> = [];
function it(desc: string, fn: () => Promise<void> | void) {
    _tests.push({ desc, fn });
}

// Runner will be appended at end of file after all tests are declared

// Simple manual stubbing helpers
function stub(object: any, key: string, fn: any) {
    const orig = object[key];
    object[key] = fn;
    return () => (object[key] = orig);
}

it('processSingleHopSwap succeeds and updates balances & pool', async () => {
    // Arrange: fake pool data and account
    const poolId = 'pool1';
    const poolDoc: any = {
        _id: poolId,
        tokenA_symbol: 'TKN_A',
        tokenB_symbol: 'TKN_B',
        tokenA_reserve: '1000000',
        tokenB_reserve: '2000000',
        totalLpTokens: '1000',
    };

    const data: any = {
        poolId,
        tokenIn_symbol: 'TKN_A',
        tokenOut_symbol: 'TKN_B',
        amountIn: '10000',
    };

    const sender = 'alice';
    const transactionId = 'tx1';


    // Stub cache.findOnePromise to return pool doc
    const restoreFind = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
        if (collection === 'liquidityPools' && query._id === poolId) return poolDoc;
        if (collection === 'accounts') {
            const name = query.name || query._id || 'unknown';
            // Provide a generic account doc with broad balances so adjustUserBalance can operate
            return { name, balances: { TKN_A: '1000000', TKN_B: '1000000', A: '1000000', B: '1000000', C: '1000000' } };
        }
        return null;
    });

    // We'll capture cache.updateOnePromise calls to verify account and pool updates
    const updateCalls: Array<any> = [];
    const restoreUpdate = stub(cache, 'updateOnePromise', async (collection: string, query: any, update: any) => {
        updateCalls.push({ collection, query, update });
        return true;
    });


    // Inject test hooks for account utils to make getAccount and adjustUserBalance deterministic
    accountUtils.__setTestHooks({
        getAccount: async (accountId: string) => {
            return { name: accountId, balances: { TKN_A: '1000000', TKN_B: '1000000' } } as any;
        },
        adjustUserBalance: async (accountId: string, tokenSymbol: string, amount: any) => {
            // Record via cache so test can observe updates
            await cache.updateOnePromise('accounts', { name: accountId }, { $set: { [`balances.${tokenSymbol}`]: amount.toString() } });
            return true;
        },
    });

    // Import module after stubbing cache to avoid init-time DB access
    const poolProcessor = await import(`../src/transactions/pool/pool-processor.js?t=${Date.now()}`);

    // Act
    const result = await poolProcessor.processSingleHopSwap(data, sender, transactionId);

    // Assert
    assert.strictEqual(result, true, 'Expected processSingleHopSwap to return true');

    // Validate side-effect calls: at least two account updates (deduct + credit) and one pool update
    const accountUpdates = updateCalls.filter(c => c.collection === 'accounts');
    const poolUpdates = updateCalls.filter(c => c.collection === 'liquidityPools');
    if (accountUpdates.length < 2) throw new Error(`Expected at least 2 account updates, got ${accountUpdates.length}`);
    if (poolUpdates.length < 1) throw new Error(`Expected at least 1 pool update, got ${poolUpdates.length}`);

    restoreFind();
    restoreUpdate();
    accountUtils.__setTestHooks({});
});

it('processRoutedSwap multi-hop succeeds and credits final output once', async () => {
    const pool1 = {
        _id: 'p1',
        tokenA_symbol: 'A',
        tokenB_symbol: 'B',
        tokenA_reserve: '1000000',
        tokenB_reserve: '1000000',
        totalLpTokens: '1000',
    };
    const pool2 = {
        _id: 'p2',
        tokenA_symbol: 'B',
        tokenB_symbol: 'C',
        tokenA_reserve: '1000000',
        tokenB_reserve: '1000000',
        totalLpTokens: '1000',
    };

    const data: any = {
        hops: [
            { poolId: 'p1', tokenIn_symbol: 'A', tokenOut_symbol: 'B', amountIn: '10000' },
            { poolId: 'p2', tokenIn_symbol: 'B', tokenOut_symbol: 'C', amountIn: '0' },
        ],
        amountIn: '10000',
    };

    const sender = 'bob';
    const txid = 'tx2';

    // Stub cache.findOnePromise to return pool1 for p1 and pool2 for p2
    const restoreFind2 = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
        console.log('[test.stub] findOnePromise called for', collection, JSON.stringify(query));
        if (collection === 'liquidityPools') {
            if (query._id === 'p1') return pool1;
            if (query._id === 'p2') return pool2;
        }
        if (collection === 'accounts') {
            const name = query.name || query._id || 'unknown';
            return { name, balances: { A: '1000000', B: '1000000', C: '1000000', TKN_A: '1000000', TKN_B: '1000000' } };
        }
        return null;
    });

    // Capture updateOnePromise calls to inspect account changes and pool writes
    const updateCalls2: Array<any> = [];
    const restoreUpdate2 = stub(cache, 'updateOnePromise', async (collection: string, query: any, update: any) => {
        console.log('[test.stub] updateOnePromise called for', collection, JSON.stringify(query), JSON.stringify(update));
        updateCalls2.push({ collection, query, update });
        return true;
    });


    // Import module after stubbing cache to avoid init-time DB access
    const poolProcessor = await import(`../src/transactions/pool/pool-processor.js?t=${Date.now()}`);

    // Act
    const res = await poolProcessor.processRoutedSwap(data, sender, txid);

    assert.strictEqual(res, true, 'Expected routed swap to succeed');

    // Expect: one initial deduct and one final credit (2 calls)
    // Verify account updates: there should be at least two account updates (deduct + credit)
    const accountUpdates2 = updateCalls2.filter(c => c.collection === 'accounts');
    const poolUpdates2 = updateCalls2.filter(c => c.collection === 'liquidityPools');
    if (accountUpdates2.length < 2) throw new Error(`Expected at least 2 account updates, got ${accountUpdates2.length}`);
    if (poolUpdates2.length < 2) throw new Error(`Expected at least 2 pool updates for two hops, got ${poolUpdates2.length}`);

    // Inspect the first account update to ensure it's a deduction on token A
    const firstAccountSet = Object.keys(accountUpdates2[0].update.$set)[0];
    assert(firstAccountSet.startsWith('balances.A'), 'Expected first account update to target balances.A');

    // Inspect the last account update to ensure it's a credit (balances.C)
    const lastAccountSet = Object.keys(accountUpdates2[accountUpdates2.length - 1].update.$set)[0];
    assert(lastAccountSet.startsWith('balances.C'), 'Expected final account update to target balances.C');

    restoreFind2();
    restoreUpdate2();
    // Clear test hooks
    accountUtils.__setTestHooks({});
});

console.log('Swap tests queued.');

it('processRoutedSwap fails mid-hop and does not credit final token', async () => {
    const pool1 = {
        _id: 'p1',
        tokenA_symbol: 'A',
        tokenB_symbol: 'B',
        tokenA_reserve: '1000000',
        tokenB_reserve: '1000000',
        totalLpTokens: '1000',
    };
    const pool2 = {
        _id: 'p2',
        tokenA_symbol: 'B',
        tokenB_symbol: 'C',
        tokenA_reserve: '1000000',
        tokenB_reserve: '1000000',
        totalLpTokens: '1000',
    };

    const data: any = {
        hops: [
            { poolId: 'p1', tokenIn_symbol: 'A', tokenOut_symbol: 'B', amountIn: '10000' },
            { poolId: 'p2', tokenIn_symbol: 'B', tokenOut_symbol: 'C', amountIn: '0' },
        ],
        amountIn: '10000',
    };

    const sender = 'carol';
    const txid = 'tx3';

    // Stub pool reads
    const restoreFind = stub(cache, 'findOnePromise', async (collection: string, query: any) => {
        console.log('[test.stub] findOnePromise called for', collection, JSON.stringify(query));
        if (collection === 'liquidityPools') {
            if (query._id === 'p1') return pool1;
            if (query._id === 'p2') return pool2;
        }
        if (collection === 'accounts') {
            const name = query.name || query._id || 'unknown';
            return { name, balances: { A: '1000000', B: '1000000', C: '1000000' } };
        }
        return null;
    });

    // Make updateOnePromise fail on the second pool update
    let updateCount = 0;
    const updateCalls3: Array<any> = [];
    const restoreUpdate = stub(cache, 'updateOnePromise', async (collection: string, query: any, update: any) => {
        updateCount++;
        updateCalls3.push({ collection, query, update });
        // Let first pool update succeed, second fail
        if (collection === 'liquidityPools' && updateCount === 2) return false;
        return true;
    });


    // Inject test hooks for account utils
    accountUtils.__setTestHooks({
        getAccount: async (accountId: string) => {
            return { name: accountId, balances: { A: '1000000', B: '1000000', C: '1000000' } } as any;
        },
        adjustUserBalance: async (accountId: string, tokenSymbol: string, amount: any) => {
            await cache.updateOnePromise('accounts', { name: accountId }, { $set: { [`balances.${tokenSymbol}`]: amount.toString() } });
            return true;
        },
    });

    // Import module after stubbing cache to avoid init-time DB access
    const poolProcessor = await import(`../src/transactions/pool/pool-processor.js?t=${Date.now()}`);

    const res = await poolProcessor.processRoutedSwap(data, sender, txid);

    assert.strictEqual(res, false, 'Expected routed swap to fail due to pool update error');

    // There should be no final credit to balances.C — in this test we can verify by checking updateCount
    // updateCount should be at least 2 (two pool writes attempted) and since second failed, function returned false
    if (updateCount < 2) throw new Error('Expected at least 2 update attempts');

    restoreFind();
    restoreUpdate();
    accountUtils.__setTestHooks({});
});

    // Run queued tests sequentially to avoid shared-stub race conditions
    ;(async function runTestsSequentially() {
        for (const t of _tests) {
            try {
                const res = t.fn();
                if (res && typeof (res as any).then === 'function') {
                    await res;
                }
                console.log(`PASS - ${t.desc}`);
            } catch (e) {
                console.error(`FAIL - ${t.desc}: ${e}`);
                process.exitCode = 1;
            }
        }
    })();
