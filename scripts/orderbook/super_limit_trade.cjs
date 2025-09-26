const fs = require('fs');
const path = require('path');
const { PrivateKey } = require('dsteem');
const { getClient, sendCustomJson } = require('../helpers.cjs');

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
    const { client, sscId } = await getClient();
    const privateKeys = loadKeys();
    const username = process.env.SUPER_TRADE_ACCOUNT || 'echelon-node1';
    const privateKey = PrivateKey.fromString(privateKeys[0]);

    // use a separate env var for the second account to avoid accidental duplication
    const username2 = process.env.SUPER_TRADE_ACCOUNT_2 || 'echelon-node2';
    const privateKey2 = PrivateKey.fromString(privateKeys[1]);

    // Optional toggle: invert BUY <-> SELL across the script for testing the opposite flow
    const INVERT_SIDES = process.env.INVERT_SIDES === '1' || process.env.INVERT_SIDES === 'true' || false;
    function sideFor(side) {
        const s = String(side || '').toUpperCase();
        if (!INVERT_SIDES) return s;
        return s === 'BUY' ? 'SELL' : 'BUY';
    }
    const SELL_LABEL = sideFor('SELL');
    const BUY_LABEL = sideFor('BUY');
    const SELL_LABEL_UP = String(SELL_LABEL).toUpperCase();
    const BUY_LABEL_UP = String(BUY_LABEL).toUpperCase();


    // API settings for snapshot checks
    const API_URL = 'http://localhost:3001';
    const PAIR_ID = 'MRY_TESTS';
    const AFTER_DELAY_MS = parseInt(process.env.AFTER_DELAY_MS || '8000', 10); // default 8s wait before checking

    async function getJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        return res.json();
    }

    try {
        console.log('=== Super Limit Trade ===');
        console.log('This script creates limit orders using the market_trade contract with a price field.');
        try {
            const { spawnSync } = require('child_process');
            console.log('Running scripts/clear_orderbook.cjs to remove any existing open orders for test accounts (cancel-only)...');
            const child = spawnSync(process.execPath || 'node', ['scripts/clear_orderbook.cjs'], { stdio: 'inherit', env: process.env });
            if (child.error) console.warn('clear_orderbook execution error:', child.error);
            else if (child.status !== 0) console.warn('clear_orderbook exited with status', child.status);
            else console.log('clear_orderbook completed successfully.');
        } catch (e) {
            console.warn('Failed to run clear_orderbook helper:', e && e.message ? e.message : e);
        }

        // Place initial limit/routed orders.
        const PLACE_INITIAL_LIMITS = process.env.PLACE_INITIAL_LIMITS === '1' || false;
        if (PLACE_INITIAL_LIMITS) {
            const limitOrder = {
                tokenIn: 'MRY',
                tokenOut: 'TESTS',
                amountIn: '10000000000', // 1.0 MRY (8 decimals)
                price: '150'
            };
            console.log('Placing limit order:');
            const payloadLimit = normalizeTradePayload(limitOrder, 1.0);
            console.log(JSON.stringify(payloadLimit, null, 2));
            await sendCustomJson(client, sscId, 'market_trade', payloadLimit, username, privateKey);
            console.log('\u2705 Limit order placed.');

            // Example: creating an orderbook routed limit order
            const routedLimit = {
                tokenIn: 'MRY',
                tokenOut: 'TESTS',
                amountIn: '75000000', // 0.75 MRY
                routes: [
                    {
                        type: 'ORDERBOOK',
                        allocation: 100,
                        details: {
                            pairId: 'MRY_TESTS',
                            side: BUY_LABEL,
                            orderType: 'LIMIT',
                            price: '450'
                        }
                    }
                ]
            };
            console.log('Placing routed limit order:');
            const payloadRouted = normalizeTradePayload(routedLimit, 1.0);
            console.log(JSON.stringify(payloadRouted, null, 2));
            await sendCustomJson(client, sscId, 'market_trade', payloadRouted, username, privateKey);
            console.log('\u2705 Routed limit order placed.');
        } else {
            console.log('Skipping initial limit placements (PLACE_INITIAL_LIMITS not set).');
        }

        // --- options for flood / buyback scenario ---
        const FLOOD_COUNT = parseInt(process.env.FLOOD_COUNT || '20', 10); // total transactions (reduced default)
        const FLOOD_DELAY_MS = parseInt(process.env.FLOOD_DELAY_MS || '150', 10);
        const RUN_ORIGINAL_FLOOD = process.env.RUN_ORIGINAL_FLOOD === '1' || false;

        // Token decimals: TESTS=3 (quote), MRY=8 (base)
        const QUOTE_DECIMALS = parseInt(process.env.QUOTE_DECIMALS || '3', 10);
        const BASE_DECIMALS = parseInt(process.env.BASE_DECIMALS || '8', 10);

        function parseDecimalToInteger(decimalStr, decimals) {
            const parts = String(decimalStr).split('.');
            const intPart = parts[0] || '0';
            const fracPart = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0');
            const combined = `${intPart}${fracPart}`.replace(/^\+/, '');
            const cleaned = combined.replace(/^0+(?!$)/, '');
            return cleaned === '' ? '0' : cleaned;
        }

        function rawToHuman(rawStr, decimals) {
            try {
                const s = String(rawStr || '0');
                const neg = s[0] === '-';
                const abs = neg ? s.slice(1) : s;
                if (abs.length <= decimals) {
                    const pad = abs.padStart(decimals, '0');
                    return (neg ? '-' : '') + '0.' + pad;
                }
                const intPart = abs.slice(0, abs.length - decimals);
                const fracPart = abs.slice(abs.length - decimals).replace(/0+$/, '');
                return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
            } catch (e) { return String(rawStr); }
        }

        function validatePayloadAmounts(payload) {
            try {
                if (!payload || typeof payload !== 'object') return;
                const token = payload.tokenIn;
                const amt = String(payload.amountIn || payload.amount || '0');
                const hasDot = amt.indexOf('.') >= 0;
                const decimals = token === 'MRY' ? BASE_DECIMALS : QUOTE_DECIMALS;
                if (hasDot) {
                    console.warn(`[validatePayloadAmounts] amountIn for tokenIn=${token} appears to be human-format (contains '.') -> converting to raw expected units is recommended. amountIn=${amt}`);
                }
                // show human friendly
                console.log(`[payload check] tokenIn=${token} amountIn(raw)=${amt} amountIn(human)=${rawToHuman(amt, decimals)} price=${payload.price}`);
            } catch (e) { /* ignore */ }
        }

        const FLOOD_PRICE_DECIMAL = process.env.FLOOD_PRICE_DECIMAL || '0.10';
        const FLOOD_PRICE = process.env.FLOOD_PRICE || parseDecimalToInteger(FLOOD_PRICE_DECIMAL, QUOTE_DECIMALS);

        async function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async function floodOrderbookTrades(count) {
            console.log(`Starting flood of ${count} small orderbook trades between ${username} and ${username2}`);
            const AMOUNT_BASE = process.env.AMOUNT_BASE || '1000000'; // amount in base smallest units (default 0.01 MRY if 1e6)
            const AMOUNT_QUOTE = process.env.AMOUNT_QUOTE || undefined;
            for (let i = 0; i < count; i++) {
                const isEven = i % 2 === 0;
                const actor = isEven ? username : username2;
                const actorKey = isEven ? privateKey : privateKey2;

                let payload;
                if (isEven) {
                    payload = normalizeTradePayload({
                        tokenIn: 'MRY',
                        tokenOut: 'TESTS',
                        amountIn: AMOUNT_BASE,
                        price: FLOOD_PRICE,
                        routes: [
                            { type: 'ORDERBOOK', allocation: 100, details: { pairId: 'MRY_TESTS', side: SELL_LABEL, orderType: 'LIMIT', price: FLOOD_PRICE } }
                        ]
                    }, 1.0);
                } else {
                    let quoteAmountToUse;
                    if (AMOUNT_QUOTE) {
                        quoteAmountToUse = AMOUNT_QUOTE;
                    } else {
                        const baseAmountBI = BigInt(AMOUNT_BASE);
                        const priceBI = BigInt(FLOOD_PRICE);
                        const scale = 10n ** BigInt(BASE_DECIMALS);
                        const numerator = baseAmountBI * priceBI;
                        const quoteBI = (numerator + scale - 1n) / scale;
                        quoteAmountToUse = quoteBI.toString();
                    }

                    payload = normalizeTradePayload({
                        tokenIn: 'TESTS',
                        tokenOut: 'MRY',
                        amountIn: quoteAmountToUse,
                        price: FLOOD_PRICE,
                        routes: [
                            { type: 'ORDERBOOK', allocation: 100, details: { pairId: 'MRY_TESTS', side: BUY_LABEL, orderType: 'LIMIT', price: FLOOD_PRICE } }
                        ]
                    }, 1.0);
                }

                try {
                    await sendCustomJson(client, sscId, 'market_trade', payload, actor, actorKey);
                    console.log(`Flood tx ${i + 1}/${count} submitted by ${actor}`);
                } catch (err) {
                    console.error(`Flood tx ${i + 1}/${count} failed for ${actor}:`, err && err.message ? err.message : err);
                }

                await sleep(FLOOD_DELAY_MS);
            }
            console.log('Flood complete.');
        }

        // --- New: helper to compute diff of user orders and print details ---
        function ensureOrdersArray(x) {
            if (!x) return [];
            if (Array.isArray(x)) return x;
            if (typeof x === 'object') {
                let arr = null;
                if (Array.isArray(x.orders)) arr = x.orders;
                else if (Array.isArray(x.data)) arr = x.data;
                else if (Array.isArray(x.result)) arr = x.result;
                else {
                    // fallback: try to pick values that look like orders
                    const vals = Object.values(x).filter(v => v && typeof v === 'object' && (v._id || v.id || v.orderId || v.rawQuantity || v.rawRemainingQuantity));
                    if (vals.length) arr = vals;
                }

                if (!arr) return [];

                // Normalize each order object: ensure canonical _id and userId fields exist
                return arr.map(o => {
                    if (!o || typeof o !== 'object') return o;
                    if (!o._id) {
                        if (o.id) o._id = o.id;
                        else if (o.orderId) o._id = o.orderId;
                        else if (o._orderId) o._id = o._orderId;
                        else if (o.txId) o._id = o.txId;
                    }
                    if (!o.userId) {
                        if (o.user) o.userId = o.user;
                        else if (o.owner) o.userId = o.owner;
                        else if (o.account) o.userId = o.account;
                        else if (o.username) o.userId = o.username;
                        else if (o.author) o.userId = o.author;
                    }
                    return o;
                });
            }
            return [];
        }

        async function diffUserOrders(beforeA, beforeB, afterA, afterB) {
            const bA = ensureOrdersArray(beforeA);
            const bB = ensureOrdersArray(beforeB);
            const aA = ensureOrdersArray(afterA);
            const aB = ensureOrdersArray(afterB);

            const setA_before = new Set(bA.map(o => o._id));
            const setB_before = new Set(bB.map(o => o._id));
            const setA_after = new Set(aA.map(o => o._id));
            const setB_after = new Set(aB.map(o => o._id));

            function diffSets(beforeSet, afterSet) {
                const removed = [];
                const added = [];
                for (const id of beforeSet) if (!afterSet.has(id)) removed.push(id);
                for (const id of afterSet) if (!beforeSet.has(id)) added.push(id);
                return { removed, added };
            }

            const aDiff = diffSets(setA_before, setA_after);
            const bDiff = diffSets(setB_before, setB_after);

            console.log('User order diffs:');
            console.log(`${username} removed orders:`, aDiff.removed);
            console.log(`${username} added orders:`, aDiff.added);
            console.log(`${username2} removed orders:`, bDiff.removed);
            console.log(`${username2} added orders:`, bDiff.added);

            return { aDiff, bDiff };
        }

        async function cancelOrdersForUser(orders, keyMap) {
            for (const order of orders || []) {
                if (!order) continue;

                // Normalize id: support a variety of fields the API might return
                const id = order._id || order.id || order.orderId || order._orderId || order.txId || null;
                if (!id) {
                    console.warn('Skipping order without id field (cannot cancel):', order);
                    continue;
                }

                // Normalize status and only attempt to cancel OPEN/PARTIALLY_FILLED (case-insensitive)
                const status = (order.status || order.state || '').toString().toUpperCase();
                if (status !== 'OPEN' && status !== 'PARTIALLY_FILLED' && status !== 'PARTIAL') {
                    console.log(`Skipping order ${id} because status='${order.status}'`);
                    continue;
                }

                // Normalize possible owner fields
                const owner = order.userId || order.user || order.owner || order.account || order.username || order.author || null;
                if (!owner) {
                    console.warn('Skipping cancel for', id, 'because owner could not be determined. Order:', order);
                    continue;
                }

                const key = keyMap[owner];
                if (!key) {
                    console.warn('No key for', owner, 'cannot cancel', id);
                    continue;
                }

                const payload = { orderId: id, pairId: PAIR_ID };
                try {
                    await sendCustomJson(client, sscId, 'market_cancel_order', payload, owner, key);
                    console.log('Cancelled order', id, 'for', owner);
                } catch (e) {
                    console.error('Cancel failed for', id, e && e.message ? e.message : e);
                }
                await sleep(FLOOD_DELAY_MS);
            }
        }

        // Snapshot before actions
        let obBefore = null;
        let uA_before = [];
        let uB_before = [];
        try {
            console.log(`Fetching orderbook snapshot and user orders BEFORE actions from ${API_URL} (pair ${PAIR_ID})`);
            obBefore = await getJson(`${API_URL}/market/orderbook/${PAIR_ID}?depth=50`);
            // Request only active orders for each user and prefer pair-scoped queries where supported
            try {
                uA_before = await getJson(`${API_URL}/market/orders/user/${username}?status=active&pairId=${PAIR_ID}`) || [];
            } catch (e) {
                uA_before = await getJson(`${API_URL}/market/orders/user/${username}?status=active`) || [];
            }
            try {
                uB_before = await getJson(`${API_URL}/market/orders/user/${username2}?status=active&pairId=${PAIR_ID}`) || [];
            } catch (e) {
                uB_before = await getJson(`${API_URL}/market/orders/user/${username2}?status=active`) || [];
            }
            const asksBefore = (obBefore && obBefore.asks) || [];
            const bidsBefore = (obBefore && obBefore.bids) || [];
            const sumAskQtyBefore = asksBefore.reduce((acc, a) => acc + BigInt(a.rawQuantity || a.quantity || '0'), 0n);
            const sumBidQtyBefore = bidsBefore.reduce((acc, b) => acc + BigInt(b.rawQuantity || b.quantity || '0'), 0n);
            console.log(`Before: asks=${asksBefore.length}, bids=${bidsBefore.length}, askQty=${sumAskQtyBefore}, bidQty=${sumBidQtyBefore}`);
            console.log(`User ${username} open orders: ${ensureOrdersArray(uA_before).length}`);
            console.log(`User ${username2} open orders: ${ensureOrdersArray(uB_before).length}`);
        } catch (err) {
            console.warn('Pre-action snapshot failed:', err && err.message ? err.message : err);
        }

        // Pre-check: if either user has OPEN or PARTIALLY_FILLED orders for the pair, cancel them first.
        try {
            const keyArr = loadKeys();
            const keyMap = { [username]: PrivateKey.fromString(keyArr[0]), [username2]: PrivateKey.fromString(keyArr[1]) };

            // Orders reported by user-orders endpoint
            // Prefer asking the API for pair-scoped user-orders if supported
            try {
                uA_before = await getJson(`${API_URL}/market/orders/user/${username}?pairId=${PAIR_ID}`) || uA_before;
            } catch (e) { /* ignore */ }
            try {
                uB_before = await getJson(`${API_URL}/market/orders/user/${username2}?pairId=${PAIR_ID}`) || uB_before;
            } catch (e) { /* ignore */ }

            const userOrdersA = ensureOrdersArray(uA_before) || [];
            const userOrdersB = ensureOrdersArray(uB_before) || [];

            // Cancel any order the user has for the pair (don't rely solely on status)
            const cancelsNeededA = userOrdersA.filter(o => !o || !o.pairId ? true : String(o.pairId) === PAIR_ID);
            const cancelsNeededB = userOrdersB.filter(o => !o || !o.pairId ? true : String(o.pairId) === PAIR_ID);

            // Ensure owner field exists so cancelOrdersForUser can pick the right key
            for (const o of cancelsNeededA) { if (o && !(o.userId || o.user || o.owner)) o.userId = username; }
            for (const o of cancelsNeededB) { if (o && !(o.userId || o.user || o.owner)) o.userId = username2; }

            // Additionally scan the orderbook snapshot for asks/bids that appear to belong to either user
            const obOrders = [];
            try {
                const asks = (obBefore && obBefore.asks) || [];
                const bids = (obBefore && obBefore.bids) || [];
                for (const o of asks.concat(bids)) {
                    if (!o) continue;
                    const owner = o.owner || o.user || o.account || o.username || o.userId || o.author || null;
                    const id = o._id || o.id || o.orderId || null;
                    const status = (o.status || 'OPEN').toString().toUpperCase();
                    if (!id || !owner) continue;
                    // Only include orders for this pair
                    if (o.pairId && String(o.pairId) !== PAIR_ID) continue;
                    obOrders.push({ _id: id, userId: owner, status, pairId: o.pairId || PAIR_ID });
                }
            } catch (e) {
                // ignore parse errors
            }

            // Merge any orderbook-detected orders into the cancel lists if they belong to our users
            for (const o of obOrders) {
                if (o.userId === username) {
                    if (!cancelsNeededA.find(x => (x._id || x.id || x.orderId) === o._id)) cancelsNeededA.push(o);
                }
                if (o.userId === username2) {
                    if (!cancelsNeededB.find(x => (x._id || x.id || x.orderId) === o._id)) cancelsNeededB.push(o);
                }
            }

            if ((cancelsNeededA.length + cancelsNeededB.length) > 0) {
                console.log(`Found ${cancelsNeededA.length} open orders for ${username} and ${cancelsNeededB.length} for ${username2} on ${PAIR_ID}. Cancelling them before proceeding.`);
                await cancelOrdersForUser(cancelsNeededA, keyMap);
                await cancelOrdersForUser(cancelsNeededB, keyMap);

                // re-fetch snapshots to confirm (fetch active orders only)
                await sleep(500);
                obBefore = await getJson(`${API_URL}/market/orderbook/${PAIR_ID}?depth=50`);
                try {
                    uA_before = await getJson(`${API_URL}/market/orders/user/${username}?status=active&pairId=${PAIR_ID}`) || [];
                } catch (e) {
                    uA_before = await getJson(`${API_URL}/market/orders/user/${username}?status=active`) || [];
                }
                try {
                    uB_before = await getJson(`${API_URL}/market/orders/user/${username2}?status=active&pairId=${PAIR_ID}`) || [];
                } catch (e) {
                    uB_before = await getJson(`${API_URL}/market/orders/user/${username2}?status=active`) || [];
                }
                const asksBefore2 = (obBefore && obBefore.asks) || [];
                const bidsBefore2 = (obBefore && obBefore.bids) || [];
                const sumAskQtyBefore2 = asksBefore2.reduce((acc, a) => acc + BigInt(a.rawQuantity || a.quantity || '0'), 0n);
                const sumBidQtyBefore2 = bidsBefore2.reduce((acc, b) => acc + BigInt(b.rawQuantity || b.quantity || '0'), 0n);
                console.log(`After cancel: asks=${asksBefore2.length}, bids=${bidsBefore2.length}, askQty=${sumAskQtyBefore2}, bidQty=${sumBidQtyBefore2}`);
                console.log(`User ${username} open orders: ${Array.isArray(uA_before) ? uA_before.length : 0}`);
                console.log(`User ${username2} open orders: ${Array.isArray(uB_before) ? uB_before.length : 0}`);
            } else {
                console.log('No pre-existing OPEN/PARTIALLY_FILLED orders to cancel for either user.');
            }
        } catch (e) {
            console.warn('Pre-cancel step failed or keys missing; continuing but you may have leftover orders:', e && e.message ? e.message : e);
        }

        // Decide which action to run: original flood or buyback scenario
        if (RUN_ORIGINAL_FLOOD) {
            await floodOrderbookTrades(FLOOD_COUNT);
        } else {
            // NEW SCENARIO: place TWO SELL orders (random amounts between 1000-10000 MRY)
            // at random prices between 0.10-0.30 TESTS, then buy them back from the second account
            // in 3 chunks each. MRY has 8 decimals, TESTS has 3 decimals.
            const MIN_HUMAN = parseInt(process.env.SELL_MIN_HUMAN || '1000', 10);
            const MAX_HUMAN = parseInt(process.env.SELL_MAX_HUMAN || '10000', 10);
            const MIN_PRICE_DEC = process.env.MIN_PRICE_DECIMAL || '0.10';
            const MAX_PRICE_DEC = process.env.MAX_PRICE_DECIMAL || '0.30';
            const CHUNKS = parseInt(process.env.BUYBACK_CHUNKS || '3', 10);
            const QUOTE_BUDGET_HUMAN = process.env.QUOTE_BUDGET_HUMAN || '500';
            const BUDGET_QUOTE_RAW = BigInt(QUOTE_BUDGET_HUMAN) * (10n ** BigInt(QUOTE_DECIMALS));
            // How many raw price ticks to bump buy chunks by (1 raw unit == smallest quote unit)
            // Default 1 makes buys slightly more aggressive than asks (helps matching engines that require a better price)
            const BUY_TICK_DELTA = parseInt(process.env.BUY_TICK_DELTA || '1', 10);

            function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
            function humanToRaw(humanAmount, decimals) { return (BigInt(humanAmount) * (10n ** BigInt(decimals))).toString(); }

            // create and process two sell orders sequentially (place -> detect -> buyback in CHUNKS)
            const SELL_POLL_MS = parseInt(process.env.SELL_POLL_MS || '500', 10);
            const SELL_POLL_ATTEMPTS = parseInt(process.env.SELL_POLL_ATTEMPTS || '20', 10);
            const baseScale = 10n ** BigInt(BASE_DECIMALS);

            // fetch buyer balance once (used as an upper bound)
            let buyerAvailable = undefined;
            try {
                const tokens = await getJson(`${API_URL}/accounts/${username2}/tokens`);
                let buyerRaw = 0n;
                if (tokens && tokens.data && Array.isArray(tokens.data)) {
                    const t = tokens.data.find(x => x.symbol === 'TESTS');
                    if (t) buyerRaw = BigInt(t.rawAmount || '0');
                } else if (Array.isArray(tokens)) {
                    const t = tokens.find(x => x.symbol === 'TESTS');
                    if (t) buyerRaw = BigInt(t.rawAmount || '0');
                }
                if (buyerRaw > 0n) buyerAvailable = buyerRaw;
            } catch (e) {
                /* ignore - we'll use configured budget */
            }

            for (let s = 0; s < 2; s++) {
                const humanAmt = randInt(MIN_HUMAN, MAX_HUMAN);
                const rawAmount = humanToRaw(humanAmt, BASE_DECIMALS);
                const humanQtyStr = `${humanAmt}.${'0'.repeat(BASE_DECIMALS)}`;

                // pick a random price between MIN_PRICE_DEC and MAX_PRICE_DEC
                const minP = parseDecimalToInteger(MIN_PRICE_DEC, QUOTE_DECIMALS);
                const maxP = parseDecimalToInteger(MAX_PRICE_DEC, QUOTE_DECIMALS);
                const pmin = BigInt(minP);
                const pmax = BigInt(maxP);
                const prange = pmax - pmin + 1n;
                const poff = BigInt(Math.floor(Math.random() * Number(prange)));
                const priceRaw = (pmin + poff).toString();

                console.log(`Placing SELL order ${s + 1}/2: ${humanAmt} MRY (raw ${rawAmount}) at price ${priceRaw}`);
                // If INVERT_SIDES is set we will actually place the opposite payload (quote->base BUY)
                let sellPayload;
                if (!INVERT_SIDES) {
                    sellPayload = normalizeTradePayload({
                        tokenIn: 'MRY', tokenOut: 'TESTS', amountIn: rawAmount, price: priceRaw,
                        routes: [{ type: 'ORDERBOOK', allocation: 100, details: { pairId: PAIR_ID, side: SELL_LABEL, orderType: 'LIMIT', price: priceRaw } }]
                    }, 1.0);
                } else {
                    // compute required quote to buy rawAmount at priceRaw (ceil)
                    const priceBI_local = BigInt(priceRaw);
                    const rawAmtBI = BigInt(rawAmount);
                    const requiredQuote = (rawAmtBI * priceBI_local + baseScale - 1n) / baseScale;
                    // In inverted flow we want to place the opposite logical order (a BUY), so tokenIn is TESTS
                    // and route side must be BUY (literal) to match tokenIn semantics.
                    sellPayload = normalizeTradePayload({
                        tokenIn: 'TESTS', tokenOut: 'MRY', amountIn: requiredQuote.toString(), price: priceRaw,
                        routes: [{ type: 'ORDERBOOK', allocation: 100, details: { pairId: PAIR_ID, side: 'BUY', orderType: 'LIMIT', price: priceRaw } }]
                    }, 1.0);
                }

                try {
                    await sendCustomJson(client, sscId, 'market_trade', sellPayload, username, privateKey);
                    if (!INVERT_SIDES) {
                        console.log('\u2705 Placed SELL order', s + 1);
                    } else {
                        // when inverted we actually sent a TESTS->MRY BUY payload; clarify amounts for the user
                        const priceBI_local = BigInt(priceRaw);
                        const rawAmtBI = BigInt(rawAmount);
                        const requiredQuote = (rawAmtBI * priceBI_local + baseScale - 1n) / baseScale;
                        console.log(`\u2705 Placed INVERTED SELL (actually a BUY) ${s + 1}: tokenIn=TESTS amountIn(raw)=${requiredQuote.toString()} amountIn(human)=${rawToHuman(requiredQuote.toString(), QUOTE_DECIMALS)} price=${priceRaw}`);
                    }
                } catch (e) {
                    console.error('Failed to place SELL order', s + 1, e && e.message ? e.message : e);
                    continue; // try next sell
                }

                // Poll for the specific order to appear in user orders
                let matchedOrder = null;
                for (let attempt = 0; attempt < SELL_POLL_ATTEMPTS; attempt++) {
                    await sleep(SELL_POLL_MS);
                    let uA_mid = [];
                    try { uA_mid = await getJson(`${API_URL}/market/orders/user/${username}?status=active`) || []; } catch (e) { uA_mid = []; }
                    const arr = ensureOrdersArray(uA_mid).filter(o => (o && ((o.side && o.side.toUpperCase() === SELL_LABEL_UP) || (o.details && String(o.details.side).toUpperCase() === SELL_LABEL_UP))));
                    for (const o of arr) {
                        try {
                            const rawQty = o.rawQuantity || o.rawAmount || o.rawRemainingQuantity || '0';
                            const qty = o.quantity || o.remaining || '0';
                            const priceCandidate = (o.price !== undefined ? o.price : (o.rawPrice !== undefined ? o.rawPrice : (o.details && o.details.price ? o.details.price : null)));
                            const priceCandRaw = priceCandidate ? parseDecimalToInteger(String(priceCandidate), QUOTE_DECIMALS) : null;
                            if ((rawQty && String(rawQty) === String(rawAmount)) || (qty && String(qty) === humanQtyStr)) {
                                if (!priceCandRaw || String(priceCandRaw) === String(priceRaw)) {
                                    matchedOrder = o;
                                    break;
                                }
                            }
                        } catch (e) { }
                    }
                    if (matchedOrder) break;
                }

                if (!matchedOrder) {
                    console.warn('Could not reliably detect the placed sell order via API. Skipping buyback for this sell.');
                    continue;
                }

                // determine remaining quantity for this matched order
                let remaining = 0n;
                try {
                    const rem = matchedOrder.remainingQuantity || matchedOrder.rawRemainingQuantity || matchedOrder.remaining || matchedOrder.quantity || '0';
                    // rem may be human-format like '7208.00000000' or raw integer; try to detect
                    if (String(rem).includes('.')) {
                        // human decimal -> convert to raw integer by removing dot
                        const parts = String(rem).split('.');
                        const intPart = parts[0] || '0';
                        const fracPart = (parts[1] || '').slice(0, BASE_DECIMALS).padEnd(BASE_DECIMALS, '0');
                        remaining = BigInt((intPart + fracPart).replace(/^0+(?!$)/, '') || '0');
                    } else {
                        remaining = BigInt(rem || '0');
                    }
                } catch (e) { remaining = 0n; }

                // get price in raw integer units
                let sellPriceRawStr = '0';
                try {
                    const candidate = (matchedOrder.price !== undefined ? matchedOrder.price : (matchedOrder.rawPrice !== undefined ? matchedOrder.rawPrice : (matchedOrder.details && matchedOrder.details.price ? matchedOrder.details.price : priceRaw)));
                    sellPriceRawStr = parseDecimalToInteger(String(candidate || priceRaw), QUOTE_DECIMALS);
                } catch (e) { sellPriceRawStr = priceRaw; }
                if (sellPriceRawStr === '0') {
                    console.warn('Skipping buyback for order with zero/invalid price:', matchedOrder);
                    continue;
                }
                const priceBI = BigInt(sellPriceRawStr);

                // Decide how much base to buy for this sell:
                // - For the first placed sell (s===0) try to fill completely
                // - For the second sell (s===1) buy half
                let totalBaseToBuy = remaining;
                try {
                    if (s === 1) {
                        totalBaseToBuy = remaining / 2n; // buy half of second order
                    }
                } catch (e) { totalBaseToBuy = remaining; }

                if (totalBaseToBuy <= 0n) {
                    console.log('No base allocated for buyback for this order (totalBaseToBuy=0). Skipping.');
                    continue;
                }

                // split base to buy into CHUNKS base-sized chunks (distribute remainder)
                const baseChunks = [];
                let baseShare = totalBaseToBuy / BigInt(CHUNKS);
                let baseRem = totalBaseToBuy % BigInt(CHUNKS);
                for (let c = 0; c < CHUNKS; c++) {
                    let piece = baseShare;
                    if (baseRem > 0n) { piece += 1n; baseRem -= 1n; }
                    baseChunks.push(piece);
                }

                console.log(`Buying back matched order: remainingRaw=${remaining} at priceRaw=${priceBI}. Base per chunk: ${baseChunks.map(x=>x.toString())}`);

                for (let c = 0; c < baseChunks.length; c++) {
                    if (remaining <= 0n) { console.log('Order fully consumed, stopping buybacks for this order.'); break; }
                    const baseToBuy = baseChunks[c];
                    if (baseToBuy <= 0n) { console.log(`Chunk ${c + 1} base amount 0, skipping.`); continue; }

                    // compute price to submit for buy chunk. Bump by BUY_TICK_DELTA when running normal (non-inverted) flow
                    const tickDeltaBI = BigInt(Math.max(0, BUY_TICK_DELTA));
                    const buyPriceBI = (!INVERT_SIDES ? (priceBI + tickDeltaBI) : priceBI);

                    // compute required quote to buy baseToBuy at buyPriceBI (ceil)
                    const requiredQuote = (baseToBuy * buyPriceBI + baseScale - 1n) / baseScale;
                    const quoteStr = requiredQuote.toString();

                    let buyPayload;
                    if (!INVERT_SIDES) {
                        // use bumped buyPriceBI so the submitted quote aligns with the posted price
                        buyPayload = normalizeTradePayload({
                            tokenIn: 'TESTS', tokenOut: 'MRY', amountIn: quoteStr, price: buyPriceBI.toString(),
                            routes: [{ type: 'ORDERBOOK', allocation: 100, details: { pairId: PAIR_ID, side: BUY_LABEL, orderType: 'LIMIT', price: buyPriceBI.toString() } }]
                        }, 1.0);
                    } else {
                        // inverted flow: place SELL (tokenIn=MRY) chunks to consume the matched order
                        // Use literal 'SELL' side so normalizeTradePayload does not flip it unexpectedly
                        buyPayload = normalizeTradePayload({
                            tokenIn: 'MRY', tokenOut: 'TESTS', amountIn: baseToBuy.toString(), price: priceBI.toString(),
                            routes: [{ type: 'ORDERBOOK', allocation: 100, details: { pairId: PAIR_ID, side: 'SELL', orderType: 'LIMIT', price: priceBI.toString() } }]
                        }, 1.0);
                    }

                    console.log(`Placing buyback chunk ${c + 1}/${baseChunks.length}: quote ${quoteStr}, baseRequestedRaw ${baseToBuy.toString()}`);
                    try {
                        await sendCustomJson(client, sscId, 'market_trade', buyPayload, username2, privateKey2);
                        // assume chunk attempts to buy up to baseToBuy; decrement remaining by baseToBuy
                        remaining -= baseToBuy;
                        if (typeof buyerAvailable !== 'undefined') {
                            try { buyerAvailable -= BigInt(quoteStr); } catch (e) { }
                        }
                    } catch (e) {
                        console.error('Buy chunk failed:', e && e.message ? e.message : e);
                    }
                    await sleep(FLOOD_DELAY_MS);
                }
            }
        }

        // Wait for reconciliation
        console.log(`Waiting ${AFTER_DELAY_MS}ms for node to process incoming trades and reconcile orderbook...`);
        await sleep(AFTER_DELAY_MS);

        // Snapshot after actions
        let obAfter = null;
        let uA_after = [];
        let uB_after = [];
        try {
            console.log(`Fetching orderbook snapshot and user orders AFTER actions from ${API_URL} (pair ${PAIR_ID})`);
            obAfter = await getJson(`${API_URL}/market/orderbook/${PAIR_ID}?depth=50`);
            uA_after = await getJson(`${API_URL}/market/orders/user/${username}?status=active`) || [];
            uB_after = await getJson(`${API_URL}/market/orders/user/${username2}?status=active`) || [];
            const asksAfter = (obAfter && obAfter.asks) || [];
            const bidsAfter = (obAfter && obAfter.bids) || [];
            const sumAskQtyAfter = asksAfter.reduce((acc, a) => acc + BigInt(a.rawQuantity || a.quantity || '0'), 0n);
            const sumBidQtyAfter = bidsAfter.reduce((acc, b) => acc + BigInt(b.rawQuantity || b.quantity || '0'), 0n);
            console.log(`After: asks=${asksAfter.length}, bids=${bidsAfter.length}, askQty=${sumAskQtyAfter}, bidQty=${sumBidQtyAfter}`);
            console.log(`User ${username} open orders: ${Array.isArray(uA_after) ? uA_after.length : 0}`);
            console.log(`User ${username2} open orders: ${Array.isArray(uB_after) ? uB_after.length : 0}`);

            // print detailed order diffs
            await diffUserOrders(uA_before, uB_before, uA_after, uB_after);

            // Detailed per-user order summaries and totals
            function summarizeOrders(orders) {
                const arr = ensureOrdersArray(orders);
                const bySide = { [BUY_LABEL_UP]: [], [SELL_LABEL_UP]: [] };
                for (const o of arr) {
                    const side = (o && ((o.side || (o.details && o.details.side)) || '')).toString().toUpperCase();
                    const remaining = o && (o.remainingQuantity || o.rawRemainingQuantity || o.remaining || o.quantity || '0') || '0';
                    const quantity = o && (o.quantity || o.rawQuantity || '0') || '0';
                    const id = (o && (o._id || o.id || o.orderId || 'unknown'));
                    const bucket = side === BUY_LABEL_UP ? BUY_LABEL_UP : SELL_LABEL_UP;
                    bySide[bucket].push({ id, side, price: o && (o.price || o.rawPrice || (o.details && o.details.price)), quantity: String(quantity), remaining: String(remaining), status: o && o.status });
                }
                return bySide;
            }

            function sumRaw(arr, fieldNames) {
                let total = 0n;
                for (const o of arr) {
                    for (const f of fieldNames) {
                        if (o[f]) { try { total += BigInt(o[f]); break; } catch (e) { } }
                    }
                }
                return total;
            }

            const summA = summarizeOrders(uA_after);
            const summB = summarizeOrders(uB_after);
            console.log(`\nDetailed per-user order summary (raw units):`);
            console.log(`${username} SELL orders:`, summA.SELL);
            console.log(`${username} BUY orders:`, summA.BUY);
            console.log(`${username2} SELL orders:`, summB.SELL);
            console.log(`${username2} BUY orders:`, summB.BUY);

            const totalRemainingSellA = sumRaw(summA.SELL, ['remaining']);
            const totalRemainingBuyA = sumRaw(summA.BUY, ['remaining']);
            const totalRemainingSellB = sumRaw(summB.SELL, ['remaining']);
            const totalRemainingBuyB = sumRaw(summB.BUY, ['remaining']);

            console.log(`Totals (raw): ${username} remaining SELL=${totalRemainingSellA} BUY=${totalRemainingBuyA}`);
            console.log(`Totals (raw): ${username2} remaining SELL=${totalRemainingSellB} BUY=${totalRemainingBuyB}`);

            // Orderbook-level diffs between obBefore and obAfter (asks/bids)
            function normalizeOb(ob) {
                if (!ob) return { asks: [], bids: [] };
                return { asks: ob.asks || [], bids: ob.bids || [] };
            }

            const nBefore = normalizeOb(obBefore);
            const nAfter = normalizeOb(obAfter);

            function obIdMap(list) {
                const map = new Map();
                for (const e of list || []) {
                    if (!e || typeof e !== 'object') continue;
                    const id = e._id || e.id || e.orderId || null;
                    if (id) map.set(id, e);
                }
                return map;
            }

            const beforeAskMap = obIdMap(nBefore.asks);
            const afterAskMap = obIdMap(nAfter.asks);
            const removedAsks = [];
            const addedAsks = [];
            for (const [id, val] of beforeAskMap.entries()) if (!afterAskMap.has(id)) removedAsks.push({ id, qty: val.rawQuantity || val.quantity || '0' });
            for (const [id, val] of afterAskMap.entries()) if (!beforeAskMap.has(id)) addedAsks.push({ id, qty: val.rawQuantity || val.quantity || '0' });

            const beforeBidMap = obIdMap(nBefore.bids);
            const afterBidMap = obIdMap(nAfter.bids);
            const removedBids = [];
            const addedBids = [];
            for (const [id, val] of beforeBidMap.entries()) if (!afterBidMap.has(id)) removedBids.push({ id, qty: val.rawQuantity || val.quantity || '0' });
            for (const [id, val] of afterBidMap.entries()) if (!beforeBidMap.has(id)) addedBids.push({ id, qty: val.rawQuantity || val.quantity || '0' });

            console.log('\nOrderbook diffs:');
            console.log('Removed asks:', removedAsks);
            console.log('Added asks:', addedAsks);
            console.log('Removed bids:', removedBids);
            console.log('Added bids:', addedBids);

            // If user requested auto-cancel of remaining orders, do it now
            const AUTO_CANCEL = process.env.AUTO_CANCEL === '1' || false;
            if (AUTO_CANCEL) {
                console.log('AUTO_CANCEL enabled: will attempt to cancel leftover OPEN/PARTIALLY_FILLED orders for both users');
                // Map keys
                const keysArr = loadKeys();
                const keyMap = { [username]: PrivateKey.fromString(keysArr[0]), [username2]: PrivateKey.fromString(keysArr[1]) };
                await cancelOrdersForUser(uA_after, keyMap);
                await cancelOrdersForUser(uB_after, keyMap);
            }

        } catch (err) {
            console.warn('Post-action snapshot failed:', err && err.message ? err.message : err);
        }

    } catch (err) {
        console.error('Super limit trade failed:', err);
    }
}

main().catch(console.error);
