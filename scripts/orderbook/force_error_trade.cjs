const fs = require('fs');
const path = require('path');
const { PrivateKey } = require('dsteem');
const { getClient, sendCustomJson } = require('../helpers.cjs');

function loadKeys() {
    try {
        const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
        return JSON.parse(keysFile);
    } catch (err) {
        console.error('Error loading keys.json file:', err && err.message ? err.message : err);
        process.exit(1);
    }
}

async function main() {
    const { client, sscId } = await getClient();
    const privateKeys = loadKeys();
    const username = process.env.SUPER_TRADE_ACCOUNT || 'echelon-node1';
    const privateKey = PrivateKey.fromString(privateKeys[0]);

    // Create a payload that fails validation: tokenIn === tokenOut
    // Validation will reject this with "Cannot trade the same token." during transaction processing
    const badPayload = {
        tokenIn: 'MRY',
        tokenOut: 'MRY',
        amountIn: '1000000', // 0.01 MRY in raw units (example)
        routes: [
            {
                type: 'ORDERBOOK',
                allocation: 100,
                details: {
                    pairId: 'MRY_TESTS',
                    side: 'SELL',
                    orderType: 'LIMIT',
                    price: '100'
                }
            }
        ]
    };

    console.log('Sending payload expected to be rejected by validation (tokenIn === tokenOut):');
    console.log(JSON.stringify(badPayload, null, 2));

    let txResult = null;
    try {
        txResult = await sendCustomJson(client, sscId, 'market_trade', badPayload, username, privateKey);
        console.log('\u2705 Broadcast succeeded, TX ID:', txResult && txResult.id ? txResult.id : '(unknown)');
    } catch (err) {
        console.error('\u274C Broadcast failed (signing/broadcast error):', err && err.message ? err.message : err);
        process.exit(2);
    }

    // Wait a short time for the node to process the transaction and write logs, then scan logs for failure
    const txId = txResult && txResult.id ? txResult.id : null;
    if (!txId) {
        console.warn('Could not determine TX ID from broadcast result; exiting.');
        process.exit(0);
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    console.log('Waiting 3 seconds for node to process transaction...');
    await sleep(3000);

    // Scan logs directory for lines mentioning the tx id or validation failure
    const logsDir = path.join(__dirname, '..', 'logs');
    try {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') || f.endsWith('.txt') || f.endsWith('.json'));
        let found = false;
        for (const f of files) {
            const fp = path.join(logsDir, f);
            try {
                const content = fs.readFileSync(fp, 'utf8');
                if (content.includes(txId) || content.includes('Specific validation failed for type MARKET_TRADE') || content.includes('Validation:')) {
                    console.log(`Found in ${f}:`);
                    // Print matching lines
                    const lines = content.split(/\r?\n/);
                    for (const line of lines) {
                        if (line.includes(txId) || line.includes('Specific validation failed for type MARKET_TRADE') || line.includes('Cannot trade the same token')) {
                            console.log(line);
                            found = true;
                        }
                    }
                }
            } catch (e) { /* ignore read errors */ }
        }
        if (!found) console.log('No matching validation failure logged yet. Check node logs (logs/) for later entries.');
    } catch (e) {
        console.warn('Failed to scan logs directory:', e && e.message ? e.message : e);
    }
}

main().catch(err => {
    console.error('Unhandled error in force_error_trade script:', err && err.message ? err.message : err);
    process.exit(3);
});
