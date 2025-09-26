// Super Hybrid Trade Script - self contained helper + demo hybrid trades
// Usage: node scripts\super_hybrid_trade.cjs
const fs = require('fs');
const path = require('path');

// Minimal embedded helpers from helpers.cjs
const { Client, PrivateKey } = require('dsteem');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function getClient() {
    const STEEM_API_URL = process.env.STEEM_API_URL || 'https://api.steemit.com';
    const SSC_ID = process.env.SSC_ID || 'sidechain';

    const CLIENT_OPTIONS = {};
    if (process.env.CHAIN_ID) CLIENT_OPTIONS.chainId = process.env.CHAIN_ID;
    if (process.env.ADDRESS_PREFIX) CLIENT_OPTIONS.addressPrefix = process.env.ADDRESS_PREFIX;

    return {
        client: new Client(STEEM_API_URL, CLIENT_OPTIONS),
        sscId: SSC_ID
    };
}

async function sendCustomJson(client, sscId, contractAction, payload, username, privateKey) {
    const operation = ['custom_json', {
        required_auths: [username],
        required_posting_auths: [],
        id: sscId,
        json: JSON.stringify({
            contract: contractAction,
            payload: payload
        })
    }];

    try {
        console.log(`Broadcasting ${contractAction} with payload:`, JSON.stringify(payload, null, 2));
        const result = await client.broadcast.sendOperations([operation], privateKey);
        console.log(`${contractAction} successful: TX ID ${result.id}`);
        console.log('block_num:', result.block_num);
        return result;
    } catch (error) {
        console.error(`Error in ${contractAction}:`, error && error.message ? error.message : error);
        if (error && error.data && error.data.stack) console.error('dsteem error data:', error.data.stack);
        throw error;
    }
}

function loadKeys() {
    try {
        const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
        return JSON.parse(keysFile);
    } catch (err) {
        console.error('Error loading keys.json file:', err.message || err);
        process.exit(1);
    }
}

// Ensure payload contains either price, minAmountOut, or maxSlippagePercent.
// If missing, default maxSlippagePercent to a safe small value and coerce numeric fields to strings.
function normalizeTradePayload(payload, defaultSlippage = 1.0) {
    if (!payload || typeof payload !== 'object') return payload;
    const p = JSON.parse(JSON.stringify(payload));
    // Coerce numeric-ish fields to strings where appropriate
    if (p.amountIn !== undefined) p.amountIn = String(p.amountIn);
    if (p.price !== undefined) p.price = String(p.price);
    if (p.minAmountOut !== undefined) p.minAmountOut = String(p.minAmountOut);

    const hasPrice = p.price !== undefined;
    const hasMinAmountOut = p.minAmountOut !== undefined;
    const hasMaxSlippage = p.maxSlippagePercent !== undefined;

    if (!hasPrice && !hasMinAmountOut && !hasMaxSlippage) {
        p.maxSlippagePercent = defaultSlippage;
        console.warn(`[normalizeTradePayload] No price/minAmountOut/maxSlippagePercent provided - defaulting maxSlippagePercent=${defaultSlippage}`);
    }

    if (Array.isArray(p.routes)) {
        p.routes = p.routes.map(r => {
            const route = JSON.parse(JSON.stringify(r));
            if (route.details && route.details.price !== undefined) route.details.price = String(route.details.price);
            // Auto-correct common user mistake: if route is ORDERBOOK BUY but tokenIn equals pair base,
            // user likely provided amountIn in base units. In that case flip to SELL to match amountIn semantics.
            if (route.type === 'ORDERBOOK' && route.details && route.details.pairId && route.details.side) {
                try {
                    const pairBase = String(route.details.pairId).split('_')[0];
                    if (String(route.details.side).toUpperCase() === 'BUY' && p.tokenIn === pairBase) {
                        console.warn(`[normalizeTradePayload] Detected ORDERBOOK BUY with tokenIn equal to pair base (${pairBase}). Flipping side to SELL to match amountIn units.`);
                        route.details.side = 'SELL';
                    }
                } catch (e) {
                    // ignore parsing errors
                }
            }
            return route;
        });
    }

    return p;
}

async function main() {
    const { default: dsteem, PrivateKey } = await import('dsteem');
    const { client, sscId } = await getClient();

    const privateKeys = loadKeys();
    const username = process.env.SUPER_TRADE_ACCOUNT || 'echelon-node1';
    const privateKey = PrivateKey.fromString(privateKeys[0]);

    try {
        console.log('=== Super Hybrid Trade Demo ===');
        console.log('This script demonstrates market (slippage) trades and mixed AMM/orderbook routing.');

        // Market-style trade (maxSlippagePercent)
        const marketTrade = {
            tokenIn: 'MRY',
            tokenOut: 'TESTS',
            amountIn: '100000000', // 1.0 MRY
            maxSlippagePercent: 5.0
        };

    console.log('Placing market-style trade:');
    const payloadMarket = normalizeTradePayload(marketTrade, 1.0);
    console.log(JSON.stringify(payloadMarket, null, 2));
    await sendCustomJson(client, sscId, 'market_trade', payloadMarket, username, privateKey);
        console.log('\u2705 Market-style trade placed.');

        // Hybrid routing example: 60% AMM, 40% ORDERBOOK
        const hybridTrade = {
            tokenIn: 'MRY',
            tokenOut: 'TESTS',
            amountIn: '50000000', // 0.5 MRY
            maxSlippagePercent: 8.0,
            routes: [
                {
                    type: 'AMM',
                    allocation: 60,
                    details: {
                        poolId: 'MRY_TESTS'
                    }
                },
                {
                    type: 'ORDERBOOK',
                    allocation: 40,
                    details: {
                        pairId: 'MRY_TESTS',
                        side: 'BUY',
                        orderType: 'MARKET'
                    }
                }
            ]
        };

    console.log('Placing hybrid trade (AMM + Orderbook allocation):');
    const payloadHybrid = normalizeTradePayload(hybridTrade, 1.0);
    console.log(JSON.stringify(payloadHybrid, null, 2));
    await sendCustomJson(client, sscId, 'market_trade', payloadHybrid, username, privateKey);
        console.log('\u2705 Hybrid trade placed.');

        // Hybrid with explicit AMM and a limit slice via orderbook
        const hybridWithLimit = {
            tokenIn: 'MRY',
            tokenOut: 'TESTS',
            amountIn: '200000000', // 2.0 MRY
            maxSlippagePercent: 6.0,
            routes: [
                { type: 'AMM', allocation: 70, details: { poolId: 'MRY_TESTS' } },
                { type: 'ORDERBOOK', allocation: 30, details: { pairId: 'MRY_TESTS', side: 'BUY', orderType: 'LIMIT', price: '48000000' } }
            ]
        };

    console.log('Placing hybrid trade with a limit sub-order:');
    const payloadHybridLimit = normalizeTradePayload(hybridWithLimit, 1.0);
    console.log(JSON.stringify(payloadHybridLimit, null, 2));
    await sendCustomJson(client, sscId, 'market_trade', payloadHybridLimit, username, privateKey);
        console.log('\u2705 Hybrid trade with limit slice placed.');

    } catch (err) {
        console.error('Super hybrid trade failed:', err);
    }
}

main().catch(console.error);
