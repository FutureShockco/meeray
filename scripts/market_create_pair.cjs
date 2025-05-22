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

    const signingPrivateKeyString = privateKeysData[0];
    const steemAccount = 'echelon-tesla'; // Account authorizing the transaction

    const createPairData = {
        baseAssetSymbol: "ECH",
        baseAssetIssuer: steemAccount, // Assuming native token or tesla is issuer
        quoteAssetSymbol: "USD",
        quoteAssetIssuer: "echelon-stablecoin-issuer", // Placeholder for actual issuer
        tickSize: 0.0001,
        lotSize: 1,
        minNotional: 1,
        initialStatus: "TRADING"
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [steemAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'market_create_pair',
                payload: createPairData
            })
        }
    ];

    console.log('Attempting to broadcast Market Create Pair operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('Market Create Pair operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting Market Create Pair operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 