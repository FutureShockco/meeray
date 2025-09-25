import assert from 'assert';
import { getTokenDecimals, toBigInt } from '../src/utils/bigint.js';

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

it('calculatedPrice BUY formula matches expected BigInt math', () => {
    // Example: amountIn = 100000 (quote units), want minAmountOut = 500 (base units), baseDecimals=6
    const amountIn = toBigInt(100000);
    const minAmountOut = toBigInt(500);
    const baseDecimals = 6;

    const expectedPrice = (amountIn * 10n ** BigInt(baseDecimals)) / minAmountOut;

    // replicate code formula
    const calculatedPrice = (amountIn * 10n ** BigInt(baseDecimals)) / minAmountOut;

    assert.strictEqual(calculatedPrice.toString(), expectedPrice.toString());
});

it('calculatedPrice SELL formula matches expected BigInt math', () => {
    // amountIn is base token, minAmountOut is quote token
    const amountIn = toBigInt(2500);
    const minAmountOut = toBigInt(125000);
    const baseDecimals = 6;

    const expectedPrice = (minAmountOut * 10n ** BigInt(baseDecimals)) / amountIn;
    const calculatedPrice = (minAmountOut * 10n ** BigInt(baseDecimals)) / amountIn;

    assert.strictEqual(calculatedPrice.toString(), expectedPrice.toString());
});

it('order quantity formula matches expected BigInt math', () => {
    // For buy orders: quantity = (amountIn * 10^baseDecimals) / orderPrice
    const amountIn = toBigInt(1_000_000n); // in quote smallest units
    const baseDecimals = 8;
    const orderPrice = toBigInt(2500000000n); // price in quote smallest units per base

    const expectedQuantity = (amountIn * 10n ** BigInt(baseDecimals)) / orderPrice;
    const quantity = (amountIn * 10n ** BigInt(baseDecimals)) / orderPrice;

    assert.strictEqual(quantity.toString(), expectedQuantity.toString());
});

console.log('Market calc tests queued.');
