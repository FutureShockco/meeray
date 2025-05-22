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

    const signingPrivateKeyString = privateKeysData[0]; // echelon-darwin's active key
    const traderAccount = 'echelon-darwin'; 
    const tokenIssuerAccount = 'echelon-token-issuer'; // Placeholder for token issuer

    // IMPORTANT: Replace with an actual poolId for TKA/TKB
    const poolIdPlaceholder = "pool-tka-tkb-example-id";

    // Example: Direct swap of 10 TKA for at least 4.5 TKB
    const poolSwapData = {
        trader: traderAccount,
        amountIn: "10.0000", // Amount of TKA to swap (string for precision)
        minAmountOut: "4.5000", // Minimum amount of TKB expected (string for precision)
        poolId: poolIdPlaceholder, // For direct swap
        tokenInSymbol: "TKA",
        tokenInIssuer: tokenIssuerAccount,
        tokenOutSymbol: "TKB",
        tokenOutIssuer: tokenIssuerAccount
        // For a routed swap, you would omit poolId and the direct tokenIn/Out fields,
        // and instead populate fromTokenSymbol, fromTokenIssuer, toTokenSymbol, toTokenIssuer, and hops array.
        /*
        fromTokenSymbol: "TKA",
        fromTokenIssuer: tokenIssuerAccount,
        toTokenSymbol: "TKC", 
        toTokenIssuer: tokenIssuerAccount,
        hops: [
            {
                poolId: "pool-tka-tkb-example-id",
                hopTokenInSymbol: "TKA",
                hopTokenInIssuer: tokenIssuerAccount,
                hopTokenOutSymbol: "TKB",
                hopTokenOutIssuer: tokenIssuerAccount
            },
            {
                poolId: "pool-tkb-tkc-example-id",
                hopTokenInSymbol: "TKB",
                hopTokenInIssuer: tokenIssuerAccount,
                hopTokenOutSymbol: "TKC",
                hopTokenOutIssuer: tokenIssuerAccount
            }
        ]
        */
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [traderAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'pool_swap',
                payload: poolSwapData
            })
        }
    ];

    console.log('Attempting to broadcast Pool Swap operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('Pool Swap operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting Pool Swap operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 