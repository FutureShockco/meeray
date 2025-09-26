const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrivateKey } = require('dsteem');
const { getClient, sendCustomJson } = require('../helpers.cjs');

function loadKeys() {
  try {
    const keysFile = fs.readFileSync(path.join(__dirname, '../keys.json'));
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

async function pollUntil(attempts, intervalMs, fetchFn, description) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchFn();
      if (res) return res;
    } catch (err) {
      if (i === 0) console.warn(`[pollUntil] first attempt error for ${description}:`, err && err.message ? err.message : err);
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return null;
}

async function main() {
  console.log('=== test_overbuy_create_remaining ===');
  const keys = loadKeys();
  const seller = process.env.TEST_MAKER || 'echelon-node1';
  const buyer = process.env.TEST_TAKER || 'echelon-node2';
  const sellerKey = PrivateKey.fromString(keys[0]);
  const buyerKey = PrivateKey.fromString(keys[1]);

  const { client, sscId } = await getClient();

  // Clear orderbook to make test deterministic
//   try {
//     console.log('Running clear_orderbook.cjs...');
//     const child = spawnSync(process.execPath || 'node', ['scripts/clear_orderbook.cjs'], { stdio: 'inherit', env: process.env });
//     if (child.error) console.warn('clear_orderbook execution error:', child.error);
//     else if (child.status !== 0) console.warn('clear_orderbook exited with status', child.status);
//     else console.log('clear_orderbook completed successfully.');
//   } catch (e) {
//     console.warn('Failed to run clear_orderbook helper:', e && e.message ? e.message : e);
//   }

  // Seller places SELL 1000 MRY at price 0.15 TESTS per MRY
  // price integer representation set to 150 (as used elsewhere in tests)
  const pairId = 'MRY_TESTS';
  const price = '150';
  const sellerMry = 1000; // human units
  const baseDecimals = 8n;
  const sellerQtyRawStr = BigInt(sellerMry) * (10n ** baseDecimals) + '';

  const sellerPayload = {
    tokenIn: 'MRY',
    tokenOut: 'TESTS',
    amountIn: sellerQtyRawStr,
    price: price,
    clientRef: `test_seller_${Date.now()}`,
    routes: [
      {
        type: 'ORDERBOOK',
        allocation: 100,
        details: {
          pairId,
          side: 'SELL',
          orderType: 'LIMIT',
          price
        }
      }
    ]
  };

  console.log('Placing seller order (SELL 1000 MRY @ 0.15 TESTS/MRY):', JSON.stringify(sellerPayload, null, 2));
  let sellerBroadcast = null;
  try {
    sellerBroadcast = await sendCustomJson(client, sscId, 'market_trade', sellerPayload, seller, sellerKey);
    console.log('Seller broadcast result:', sellerBroadcast);
  } catch (err) {
    console.error('Seller broadcast failed:', err && err.message ? err.message : err);
    return;
  }

  // Poll API for seller order to appear in active orders
  console.log('Polling API for seller order (active)...');
  const sellerOrder = await pollUntil(12, 3000, async () => {
    try {
      const url = `http://localhost:3001/market/orders/user/${seller}?status=active&pairId=${pairId}`;
      const orders = await getJson(url);
      const arr = Array.isArray(orders) ? orders : (orders && orders.data) ? orders.data : (orders && orders.orders) ? orders.orders : [];
      if (arr.length > 0) return arr[0];
      return null;
    } catch (err) { throw err; }
  }, `seller order for ${seller}`);

  if (sellerOrder) console.log('Found seller order:', sellerOrder._id || sellerOrder.id || sellerOrder.orderId || sellerOrder.txId);
  else console.warn('Seller order not found via API; will proceed and use broadcast TX id for logs.');

  const sellerOrderId = (sellerOrder && (sellerOrder._id || sellerOrder.id || sellerOrder.orderId || sellerOrder.txId)) || (sellerBroadcast && sellerBroadcast.id) || null;

  // Buyer attempts to buy 2500 MRY (more than seller's 1000)
  const buyerMryWanted = 2500n;
  const priceBI = BigInt(price);
  const buyerQtyRaw = buyerMryWanted * (10n ** baseDecimals);
  const scale = 10n ** baseDecimals;
  const requiredQuote = (priceBI * buyerQtyRaw + scale - 1n) / scale; // ceil

  const buyerPayload = {
    tokenIn: 'TESTS',
    tokenOut: 'MRY',
    amountIn: requiredQuote.toString(),
    price: price,
    clientRef: `test_buyer_${Date.now()}`,
    routes: [
      {
        type: 'ORDERBOOK',
        allocation: 100,
        details: {
          pairId,
          side: 'BUY',
          orderType: 'LIMIT',
          price
        }
      }
    ]
  };

  console.log('Placing buyer order (BUY 2000 MRY):', JSON.stringify(buyerPayload, null, 2));
  let buyerBroadcast = null;
  try {
    buyerBroadcast = await sendCustomJson(client, sscId, 'market_trade', buyerPayload, buyer, buyerKey);
    console.log('Buyer broadcast result:', buyerBroadcast);
  } catch (err) {
    console.error('Buyer broadcast failed:', err && err.message ? err.message : err);
    return;
  }

  // Wait a bit for matching to occur, then poll API for final states
  console.log('Waiting 3s before polling post-trade API...');
  await sleep(3000);

  // Poll for seller order (all statuses) to be present and likely FILLED
  const postSeller = await pollUntil(10, 3000, async () => {
    try {
      const url = `http://localhost:3001/market/orders/user/${seller}?status=all&pairId=${pairId}`;
      const orders = await getJson(url);
      const arr = Array.isArray(orders) ? orders : (orders && orders.data) ? orders.data : (orders && orders.orders) ? orders.orders : [];
      const found = arr.find(o => (o._id || o.id || o.orderId || o.txId) === sellerOrderId) || arr[0];
      if (found) return found;
      return null;
    } catch (err) { throw err; }
  }, `post-trade seller order ${sellerOrderId}`);

  if (postSeller) {
    console.log('Seller order after trade:');
    console.log('id:', sellerOrderId);
    console.log('status:', postSeller.status);
    console.log('quantity:', postSeller.quantity);
    console.log('filledQuantity:', postSeller.filledQuantity);
    console.log('remainingQuantity:', postSeller.remainingQuantity);
  } else {
    console.warn('Seller order not found after trade.');
  }

  // Poll for buyer active orders to find remaining order (should be ~1000 MRY remaining)
  const postBuyer = await pollUntil(10, 3000, async () => {
    try {
      const url = `http://localhost:3001/market/orders/user/${buyer}?status=active&pairId=${pairId}`;
      const orders = await getJson(url);
      const arr = Array.isArray(orders) ? orders : (orders && orders.data) ? orders.data : (orders && orders.orders) ? orders.orders : [];
      if (arr.length > 0) return arr[0];
      return null;
    } catch (err) { throw err; }
  }, `post-trade buyer active order`);

  if (postBuyer) {
    console.log('Buyer active order after trade (remaining):');
    console.log('id:', postBuyer._id || postBuyer.id || postBuyer.orderId || postBuyer.txId);
    console.log('status:', postBuyer.status);
    console.log('quantity:', postBuyer.quantity);
    console.log('filledQuantity:', postBuyer.filledQuantity);
    console.log('remainingQuantity:', postBuyer.remainingQuantity);

    // Convert quantity strings to raw integers if needed for comparison
    let remRaw = null;
    try {
      const q = String(postBuyer.remainingQuantity || postBuyer.quantity || '0');
      remRaw = q.includes('.') ? parseDecimalToInteger(q, 8) : q.replace(/^0+(?!$)/, '') || '0';
    } catch (e) { remRaw = null; }
    if (remRaw) {
      const remBig = BigInt(remRaw);
      const expectedRem = (BigInt(sellerMry) * (10n ** baseDecimals)) - 0n; // seller sold 1000, buyer requested 2000 so remaining should be 1000 MRY raw
      // compute expected remaining for buyer = buyerWanted - sellerQty => 2000 - 1000 = 1000
      const expectedRemainingRaw = (buyerMryWanted => {});
      // We'll just print a human check below
      console.log('remaining raw (parsed):', remRaw);
    }
  } else {
    console.warn('No active buyer order found after trade. Buyer may have fully filled or there is no remaining order.');
  }

  // Scan logs for persistence lines related to seller/buyer
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    const needlePatterns = [sellerOrderId, (buyerBroadcast && buyerBroadcast.id) || '', 'Persisted FILLED state for maker order', 'Persisted final taker order state', 'Failed to persist FILLED state for maker order'];
    console.log('Scanning logs for persistence and order id entries...');
    for (const file of files) {
      const full = path.join(logsDir, file);
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const pat of needlePatterns) {
        if (!pat) continue;
        const matches = lines.filter(l => l.includes(pat));
        if (matches.length) {
          console.log(`Found in ${file} for pattern '${pat}':`);
          console.log(matches.slice(-10).join('\n'));
        }
      }
    }
  } catch (err) {
    console.warn('Log scan failed:', err && err.message ? err.message : err);
  }

  console.log('Test complete.');
}

main().catch(err => {
  console.error('Test failed:', err && err.message ? err.message : err);
  process.exit(1);
});
