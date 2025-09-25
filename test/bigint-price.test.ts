import assert from 'assert';
import { setTokenDecimals, calculateDecimalAwarePrice, parseTokenAmount } from '../src/utils/bigint.js';

// Simple test harness
function it(desc: string, fn: () => void) {
    try {
        fn();
        console.log(`PASS - ${desc}`);
    } catch (err) {
        console.error(`FAIL - ${desc}: ${String(err)}`);
        process.exitCode = 1;
    }
}

// Setup token decimals
setTokenDecimals('TOKEN8', 8);
setTokenDecimals('TOKEN18', 18);
setTokenDecimals('TOKEN6', 6);

it('calculate price when base has fewer decimals than quote', () => {
    const amountIn = parseTokenAmount('1.00000000', 'TOKEN8'); // 1 TOKEN8
    const amountOut = parseTokenAmount('2.000000000000000000', 'TOKEN18'); // 2 TOKEN18
    const price = calculateDecimalAwarePrice(amountIn, amountOut, 'TOKEN8', 'TOKEN18');
    // price should be (1 * 10^(quoteDecimals+decimalDifference)) / 2
    assert(price > 0n);
});

it('calculate price when base has more decimals than quote', () => {
    const amountIn = parseTokenAmount('1.000000000000000000', 'TOKEN18'); // 1 TOKEN18
    const amountOut = parseTokenAmount('100.000000', 'TOKEN6'); // 100 TOKEN6
    const price = calculateDecimalAwarePrice(amountIn, amountOut, 'TOKEN18', 'TOKEN6');
    assert(price > 0n);
});

it('returns 0 for zero amounts', () => {
    const price = calculateDecimalAwarePrice(0n, 1000n, 'TOKEN8', 'TOKEN18');
    assert.strictEqual(price, 0n);
});

console.log('Tests completed.');
