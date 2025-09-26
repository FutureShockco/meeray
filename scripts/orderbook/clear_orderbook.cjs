const { getClient, getMasterAccount, getSecondAccount, sendCustomJson, sendMultiCustomJson } = require('../helpers.cjs');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const PAIR_ID = process.env.PAIR_ID || 'MRY_TESTS';
const DELAY_MS = parseInt(process.env.DELAY_MS || '200', 10);

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return res.json();
}

async function main() {
    // Use shared helpers to get the client and master/second accounts
    const { client, sscId } = await getClient();
    const { username: user1, privateKey: user1Pk } = await getMasterAccount();
    const { username: user2, privateKey: user2Pk } = await getSecondAccount();
    // Map usernames to private keys by the simple convention used in other scripts
    const keyMap = {
        [user1]: user1Pk,
        [user2]: user2Pk,
    };

    try {
        console.log(`Fetching open orders for users ${user1} and ${user2} on pair ${PAIR_ID} from ${API_URL}`);
        let ordersA;
        let ordersB;
        try {
            ordersA = await getJson(`${API_URL}/market/orders/user/${user1}?status=active&pairId=${PAIR_ID}`);
        } catch (e) {
            try { ordersA = await getJson(`${API_URL}/market/orders/user/${user1}?status=active`); } catch (e) { ordersA = []; }
        }
        try {
            ordersB = await getJson(`${API_URL}/market/orders/user/${user2}?status=active&pairId=${PAIR_ID}`);
        } catch (e) {
            try { ordersB = await getJson(`${API_URL}/market/orders/user/${user2}?status=active`); } catch (e) { ordersB = []; }
        }
        if (ordersA && ordersA.orders) ordersA = ordersA.orders;
        if (ordersB && ordersB.orders) ordersB = ordersB.orders;
        if (!Array.isArray(ordersA)) ordersA = Array.isArray(ordersA.data) ? ordersA.data : [];
        if (!Array.isArray(ordersB)) ordersB = Array.isArray(ordersB.data) ? ordersB.data : [];
        const allOrders = [].concat(ordersA || [], ordersB || []);
        const initialOrdersMap = {
            [user1]: Array.isArray(ordersA) ? ordersA : [],
            [user2]: Array.isArray(ordersB) ? ordersB : []
        };
        for (const o of allOrders) {
            if (!o._id && o.id) o._id = o.id;
            if (!o.userId && o.user) o.userId = o.user;
            if (!o.userId && o.owner) o.userId = o.owner;
            if (!o.pairId && o.pair) o.pairId = o.pair;
        }
        try {
            if (Array.isArray(ordersA)) {
                for (const o of ordersA) {
                    if (o && !o.userId) o.userId = user1;
                    if (o && !o._id && o.id) o._id = o.id;
                }
            }
            if (Array.isArray(ordersB)) {
                for (const o of ordersB) {
                    if (o && !o.userId) o.userId = user2;
                    if (o && !o._id && o.id) o._id = o.id;
                }
            }
        } catch (e) {
            // ignore
        }
        const cancellable = allOrders.filter(o => String(o.pairId) === String(PAIR_ID) && (String(o.status).toUpperCase() === 'OPEN' || String(o.status).toUpperCase() === 'PARTIALLY_FILLED'));
        console.log(`Found ${cancellable.length} cancellable orders for ${user1}/${user2} on ${PAIR_ID} (cancelling all)`);
        const ops = [];
        let owner = null;
        let key = null;
        for (const order of cancellable) {
            console.log('Order ->', order._id, order.side, 'qty:', order.remainingQuantity || order.quantity, 'price:', order.price);
            owner = order.userId;
            key = keyMap[owner];
            if (!key) {
                console.warn('No key found for owner', owner, '- skipping cancellation for', order._id);
                continue;
            }
            let ownerOrders = Array.isArray(initialOrdersMap[owner]) ? initialOrdersMap[owner] : [];
            if (!ownerOrders || ownerOrders.length === 0) {
                try {
                    ownerOrders = await getJson(`${API_URL}/market/orders/user/${owner}?status=active&pairId=${PAIR_ID}`);
                } catch (e) {
                    try { ownerOrders = await getJson(`${API_URL}/market/orders/user/${owner}?status=active`); } catch (e2) { ownerOrders = []; }
                }
                ownerOrders = Array.isArray(ownerOrders) ? ownerOrders : ownerOrders.orders || ownerOrders.data || [];
            }
            const normalizedOwnerOrders = (ownerOrders || []).map(o => {
                if (!o || typeof o !== 'object') return o;
                if (!o._id) {
                    if (o.id) o._id = o.id;
                    else if (o.orderId) o._id = o.orderId;
                }
                return o;
            });
            const found = normalizedOwnerOrders.some(o => {
                if (!o) return false;
                const candidate = String(o._id || o.id || o.orderId || '');
                return candidate === String(order._id);
            });
            if (!found) {
                try {
                    const ids = normalizedOwnerOrders.slice(0, 10).map(o => String(o._id || o.id || o.orderId || '(no-id)'));
                    console.warn(`Pre-check: order ${order._id} not present in API for user ${owner}. Skipping cancel to avoid server validation failure.`);
                    console.warn(`  API returned ${normalizedOwnerOrders.length} orders for ${owner}. Sample IDs:`, ids);
                } catch (e) {
                    console.warn(`Pre-check: order ${order._id} not present in API for user ${owner}. (could not summarize owner orders)`);
                }
                continue;
            }
            const payload = { orderId: String(order._id), pairId: String(PAIR_ID) };
            ops.push({ contractAction: 'market_cancel_order', payload });
            console.log('Cancelling order', order._id);

        }
        try {

            await sendMultiCustomJson(client, sscId, ops, owner, key);
        } catch (err) {
            console.error('Failed to cancel order with active auth', ops, 'error:', err && err.message ? err.message : err);
        }
        await sleep(DELAY_MS);
        console.log('clear_orderbook script complete (cancel-only).');
    } catch (err) {
        console.error('Error running clear_orderbook:', err && err.message ? err.message : err);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error in clear_orderbook:', err && err.message ? err.message : err);
    process.exit(1);
});
