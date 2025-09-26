const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseDecimalToInteger(decimalStr, decimals) {
  const s = String(decimalStr || '0');
  if (!s.includes('.')) return s.replace(/^0+(?!$)/, '') || '0';
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  const fracPart = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0');
  const combined = (intPart + fracPart).replace(/^0+(?!$)/, '');
  return combined === '' ? '0' : combined;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Poll helper: try fetchFn repeatedly until it returns a truthy value or attempts exhausted
async function pollUntil(attempts, intervalMs, fetchFn, description) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchFn();
      if (res) return res;
    } catch (err) {
      // ignore individual attempt errors but log on first/last attempt
      if (i === 0) console.warn(`[pollUntil] first attempt error for ${description}:`, err && err.message ? err.message : err);
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return null;
}

async function main() {
  console.log('=== test_full_fill_reconcile ===');
  const keys = loadKeys();
  const maker = process.env.TEST_MAKER || 'echelon-node1';
  const taker = process.env.TEST_TAKER || 'echelon-node2';
  const makerKey = PrivateKey.fromString(keys[0]);
  const takerKey = PrivateKey.fromString(keys[1]);

  const { client, sscId } = await getClient();

  // Clear orderbook first
  try {
    console.log('Running clear_orderbook.cjs...');
    const child = spawnSync(process.execPath || 'node', ['scripts/clear_orderbook.cjs'], { stdio: 'inherit', env: process.env });
    if (child.error) console.warn('clear_orderbook execution error:', child.error);
    else if (child.status !== 0) console.warn('clear_orderbook exited with status', child.status);
    else console.log('clear_orderbook completed successfully.');
  } catch (e) {
    console.warn('Failed to run clear_orderbook helper:', e && e.message ? e.message : e);
  }

  // Place a single maker limit SELL order (MRY -> TESTS)
  // Use 1 MRY as the base quantity. Base decimals = 8, so 1 MRY == 100000000 (1 * 10^8)
  const makerQuantity = '100000000';
  const makerPrice = '150'; // price in quote-per-base as integer (will be interpreted by engine)
  const pairId = 'MRY_TESTS';

  const makerPayload = {
    tokenIn: 'MRY',
    tokenOut: 'TESTS',
    amountIn: makerQuantity,
    price: makerPrice,
    clientRef: `test_maker_${Date.now()}`,
    routes: [
      {
        type: 'ORDERBOOK',
        allocation: 100,
        details: {
          pairId,
          side: 'SELL',
          orderType: 'LIMIT',
          price: makerPrice
        }
      }
    ]
  };

  console.log('Placing maker order:', JSON.stringify(makerPayload, null, 2));
  let makerBroadcastResult = null;
  try {
    makerBroadcastResult = await sendCustomJson(client, sscId, 'market_trade', makerPayload, maker, makerKey);
    console.log('Maker broadcast result:', makerBroadcastResult);
  } catch (err) {
    console.error('Maker broadcast failed:', err && err.message ? err.message : err);
    return;
  }

  // Wait for node to process and for API to show the order
  // Increased wait to 8s to allow more time for processing (per user request: 6-9s)
  // Poll the API every 3s up to 12 attempts to find the maker order in active orders
  console.log('Polling API up to 12 times (3s interval) for maker order to appear...');
  const makerOrder = await pollUntil(12, 3000, async () => {
    try {
  const url = `http://localhost:3001/market/orders/user/${maker}?status=active&pairId=${pairId}`;
  const orders = await getJson(url);
  const arr = Array.isArray(orders) ? orders : (orders && orders.data) ? orders.data : (orders && orders.orders) ? orders.orders : [];
      if (arr.length > 0) return arr[0];
      return null;
    } catch (err) {
      throw err;
    }
  }, `maker order for ${maker} ${pairId}`);

  if (makerOrder) console.log('Found maker order:', makerOrder._id || makerOrder.id || makerOrder.orderId);

  if (!makerOrder) {
    // Don't abort here — submit the taker anyway to force matching.
    // Use maker broadcast TX id as a fallback identifier for log scanning.
    console.warn('Failed to locate maker order via API. Proceeding to submit taker to force matching.');
    if (makerBroadcastResult && makerBroadcastResult.id) {
      console.log('Falling back to maker broadcast TX id for log scanning:', makerBroadcastResult.id);
    }
    // Note: makerQtyRaw below will fall back to the configured makerQuantity value when makerOrder is null.
  }

  const makerOrderId = (makerOrder && (makerOrder._id || makerOrder.id || makerOrder.orderId || makerOrder.txId)) || (makerBroadcastResult && makerBroadcastResult.id) || null;
  // Normalize maker quantity to raw integer string (handles '1.00000000' style)
  let makerQtyRawStr = makerQuantity;
  try {
    if (makerOrder && makerOrder.quantity !== undefined) {
      const q = String(makerOrder.quantity);
      if (q.includes('.')) {
        makerQtyRawStr = parseDecimalToInteger(q, 8);
      } else {
        makerQtyRawStr = q;
      }
    }
  } catch (e) { /* fallback to configured value */ }
  const makerQtyRaw = BigInt(makerQtyRawStr);
  const priceBI = BigInt(makerPrice);
  // compute quote amount required to buy this makerQuantity using ceiling to avoid underpaying:
  // quoteAmount = ceil(price * quantity / (10^baseDecimals))
  const baseDecimals = 8n;
  const scale = 10n ** baseDecimals;
  const numerator = priceBI * makerQtyRaw;
  const quoteAmountCeil = (numerator + scale - 1n) / scale;

  // Split taker into two ORDERBOOK LIMIT BUY transactions: 70% then remaining 30%
  const pct1 = 70n;
  const pct2 = 30n;
  const totalBase = makerQtyRaw; // in raw base units
  const baseChunk1 = (totalBase * pct1) / 100n; // floor
  const baseChunk2 = totalBase - baseChunk1;

  const takerResults = [];

  async function sendTakerForBaseChunk(baseChunk, label) {
    if (!baseChunk || baseChunk <= 0n) return null;
    // compute required quote for this base chunk (ceil)
    const numer = priceBI * baseChunk;
    const requiredQuote = (numer + scale - 1n) / scale;
    const payload = {
      tokenIn: 'TESTS',
      tokenOut: 'MRY',
      amountIn: requiredQuote.toString(),
      price: makerPrice,
      clientRef: `test_taker_${label}_${Date.now()}`,
      routes: [
        {
          type: 'ORDERBOOK',
          allocation: 100,
          details: {
            pairId: pairId,
            side: 'BUY',
            orderType: 'LIMIT',
            price: makerPrice
          }
        }
      ]
    };

    console.log(`Placing taker chunk ${label}:`, JSON.stringify(payload, null, 2));
    try {
      const res = await sendCustomJson(client, sscId, 'market_trade', payload, taker, takerKey);
      console.log(`Taker chunk ${label} broadcast result:`, res);
      return { payload, res };
    } catch (err) {
      console.error(`Taker chunk ${label} broadcast failed:`, err && err.message ? err.message : err);
      return { payload, res: null, err };
    }
  }

  // Send first 70%
  const r1 = await sendTakerForBaseChunk(baseChunk1, '70');
  takerResults.push(r1);
  // small pause between chunks to let node schedule processing
  await sleep(3000);
  // Send second chunk (remaining)
  const r2 = await sendTakerForBaseChunk(baseChunk2, '30');
  takerResults.push(r2);

  // Instead of a single long sleep, poll every 3s (max 10 attempts) for the maker order to appear in post-trade (status=all)
  console.log('Polling API up to 10 times (3s interval) for post-trade maker order status...');
  const foundMakerAfter = await pollUntil(10, 3000, async () => {
    try {
  const url2 = `http://localhost:3001/market/orders/user/${maker}?status=active&pairId=${pairId}`;
  const ordersAfter = await getJson(url2);
  const arrAfter = Array.isArray(ordersAfter) ? ordersAfter : (ordersAfter && ordersAfter.data) ? ordersAfter.data : (ordersAfter && ordersAfter.orders) ? ordersAfter.orders : [];
      const found = arrAfter.find(o => (o._id || o.id || o.orderId || o.txId) === makerOrderId);
      if (found) return { ordersAfter: arrAfter, found };
      return null;
    } catch (err) {
      throw err;
    }
  }, `post-trade maker order ${makerOrderId}`);

  if (foundMakerAfter && foundMakerAfter.found) {
    const found = foundMakerAfter.found;
    console.log('Maker order after trade:');
    console.log('id:', makerOrderId);
    console.log('status:', found.status);
    console.log('quantity:', found.quantity);
    console.log('filledQuantity:', found.filledQuantity);
    console.log('remainingQuantity:', found.remainingQuantity);
    console.log('updatedAt:', found.updatedAt);
  } else {
    console.warn('Maker order not found in post-trade query after polling.');
  }

  // Fetch maker order from API (all statuses)
  try {
  const url2 = `http://localhost:3001/market/orders/user/${maker}?status=active&pairId=${pairId}`;
  const ordersAfter = await getJson(url2);
  const arrAfter = Array.isArray(ordersAfter) ? ordersAfter : (ordersAfter && ordersAfter.data) ? ordersAfter.data : (ordersAfter && ordersAfter.orders) ? ordersAfter.orders : [];
    const found = arrAfter.find(o => (o._id || o.id || o.orderId || o.txId) === makerOrderId);
    if (!found) {
      console.warn('Maker order not found in post-trade query. Printing total orders for user:', arrAfter.length);
      if (arrAfter.length > 0) console.log(JSON.stringify(arrAfter[0], null, 2));
    } else {
      console.log('Maker order after trade:');
      console.log('id:', makerOrderId);
      console.log('status:', found.status);
      console.log('quantity:', found.quantity);
      console.log('filledQuantity:', found.filledQuantity);
      console.log('remainingQuantity:', found.remainingQuantity);
      console.log('updatedAt:', found.updatedAt);
    }
  } catch (err) {
    console.warn('Error fetching post-trade maker orders:', err && err.message ? err.message : err);
  }

  // Scan logs for persistence error lines and for this maker order id
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    const needlePatterns = [makerOrderId, 'Failed to persist FILLED state for maker order', 'Failed to persist trade', 'Specific validation failed for type MARKET_TRADE'];
    console.log('Scanning logs for order id and persistence errors...');
    for (const file of files) {
      const full = path.join(logsDir, file);
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const pat of needlePatterns) {
        const matches = lines.filter(l => l.includes(pat));
        if (matches.length) {
          console.log(`Found in ${file} for pattern '${pat}':`);
          console.log(matches.slice(-5).join('\n'));
        }
      }
    }
  } catch (err) {
    console.warn('Log scan failed:', err && err.message ? err.message : err);
  }

  console.log('Test complete.');
}

main().catch(err => {
  console.error('Test script failed:', err && err.message ? err.message : err);
  process.exit(1);
});

