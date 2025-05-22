const { Client, PrivateKey } = require('dsteem');
const fs = require('fs');
const path = require('path');

// Configuration
const STEEM_API_URL = 'https://api.justyy.com';
const KEYS_FILE_PATH = path.join(__dirname, 'keys.json'); // Assumes keys.json is in the same directory

async function main() {
    const client = new Client(STEEM_API_URL);
    let privateKeysData;
    try {
        const keysFileContent = fs.readFileSync(KEYS_FILE_PATH, 'utf8');
        privateKeysData = JSON.parse(keysFileContent);
        if (!privateKeysData || !Array.isArray(privateKeysData) || privateKeysData.length === 0) {
            console.error('Error: keys.json is missing, empty, or not an array. Please ensure it contains at least one private key string.');
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error loading or parsing ${KEYS_FILE_PATH}:`, err.message);
        console.error('Please ensure keys.json exists in the scripts directory and contains an array of private key strings.');
        process.exit(1);
    }

    // Use the first private key from the keys.json array
    const signingPrivateKeyString = privateKeysData[0]; 
    const steemAccount = 'echelon-tesla'; // This account needs to have its active key in keys.json[0]

    const collectionData = {
        symbol: "ARTBK",
        name: "Art Blocks Knockoff",
        creator: steemAccount, // Account from accounts_steem.json
        maxSupply: 1000,
        mintable: true,
        burnable: true,
        transferable: true,
        creatorFee: 5, // 5%
        schema: JSON.stringify({ type: "object", properties: { edition: { type: "integer" }, artist: { type: "string" } } }),
        description: "A collection of generative art.",
        logoUrl: "https://example.com/logo.png",
        websiteUrl: "https://example.com/myart"
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [steemAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'nft_create_collection', // Derived from "NFT Create Collection"
                payload: collectionData
            })
        }
    ];

    console.log('Attempting to broadcast operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('NFT Create Collection operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting NFT Create Collection operation:', error.message);
        if (error.data && error.data.stack) {
            // Log dsteem specific error details if available
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 