const { Client, PrivateKey } = require('dsteem');
const fs = require('fs');
const path = require('path');

// Configuration
const STEEM_API_URL = 'https://api.justyy.com';
const KEYS_FILE_PATH = path.join(__dirname, 'keys.json');

async function main() {
    const client = new Client(STEEM_API_URL);
    let privateKeysData;
    try {
        const keysFileContent = fs.readFileSync(KEYS_FILE_PATH, 'utf8');
        privateKeysData = JSON.parse(keysFileContent);
        if (!privateKeysData || !Array.isArray(privateKeysData) || privateKeysData.length === 0) {
            console.error('Error: keys.json is missing, empty, or not an array.');
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error loading or parsing ${KEYS_FILE_PATH}:`, err.message);
        process.exit(1);
    }

    const signingPrivateKeyString = privateKeysData[0]; // IMPORTANT: This should be echelon-edison's active key
    const userIdAccount = 'echelon-edison'; // Account placing the order

    // Assuming pairId is known from market_create_pair.cjs (e.g., ECH:echelon-tesla/USD:echelon-stablecoin-issuer)
    // For testing, use a placeholder or the actual ID if available
    const pairIdPlaceholder = "ECH:echelon-tesla/USD:echelon-stablecoin-issuer"; 

    const placeOrderData = {
        userId: userIdAccount, // This will be the sender
        pairId: pairIdPlaceholder, 
        type: "LIMIT", // OrderType: LIMIT, MARKET
        side: "BUY",   // OrderSide: BUY, SELL
        price: 0.95, // Required for LIMIT order
        quantity: 100, // Amount of base asset (ECH)
        // quoteOrderQty: 95, // Alternatively, for MARKET BUY by quote amount (USD)
        timeInForce: "GTC" // Good 'Til Canceled
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [userIdAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'market_place_order',
                payload: placeOrderData
            })
        }
    ];

    console.log('Attempting to broadcast Market Place Order operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('Market Place Order operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting Market Place Order operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 