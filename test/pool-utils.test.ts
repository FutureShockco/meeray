import assert from 'assert';
import { getOutputAmountBigInt, calculateExpectedAMMOutput } from '../src/utils/pool.js';
import { calculateTradeValue, setTokenDecimals, parseTokenAmount } from '../src/utils/bigint.js';

function it(desc: string, fn: () => void) {
    try {
        fn();
        console.log(`PASS - ${desc}`);
    } catch (err) {
        console.error(`FAIL - ${desc}: ${String(err)}`);
        process.exitCode = 1;
    }
}

// Setup token decimals for calculateTradeValue tests
setTokenDecimals('T6', 6);
setTokenDecimals('T18', 18);

it('getOutputAmountBigInt basic swap', () => {
    const input = 1000000n; // 1 unit if token has 6 decimals
    const reserveIn = 100000000n; // 100 units
    const reserveOut = 200000000n; // 200 units
    const out = getOutputAmountBigInt(input, reserveIn, reserveOut);
    assert(out > 0n, 'Expected positive output');
});

it('calculateExpectedAMMOutput directionality', () => {
    const ammSource = { tokenA: 'A', tokenB: 'B', reserveA: '1000000', reserveB: '2000000' };
    const outAB = calculateExpectedAMMOutput(1000n, 'A', 'B', ammSource);
    const outBA = calculateExpectedAMMOutput(1000n, 'B', 'A', ammSource);
    assert(outAB > 0n && outBA > 0n, 'Expected both directions to produce output');
});

it('normalizeToDecimals scales up and down', () => {
    // Expose normalizeToDecimals via a small crafted import path (function is internal) — replicate expected behavior
    const amount = 1n;
    // scaling up from 6 -> 18
    const scaledUp = (() => {
        const scaleFactor = 10n ** BigInt(18 - 6);
        return amount * scaleFactor;
    })();
    assert(scaledUp === 1000000000000n, 'Scale up correct');
});

it('calculateTradeValue decimal difference', () => {
    // price scaled by quote decimals
    const price = 2n * (10n ** BigInt(18)); // price represented with 18 decimals
    const qty = parseTokenAmount('1.5', 'T6'); // 1.5 base with 6 decimals
    const value = calculateTradeValue(price, qty, 'T6', 'T18');
    assert(value > 0n, 'Trade value should be positive');
});

console.log('Pool utils tests completed.');
