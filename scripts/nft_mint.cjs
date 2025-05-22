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
    const authorizingAccount = 'echelon-tesla'; // Account used in required_auths, its active key is in keys.json[0]
    const nftOwnerAccount = 'echelon-edison';   // Account that will own the minted NFT

    const mintData = {
        collectionSymbol: "ARTBK", // Symbol of the collection created in nft_create_collection.cjs
        instanceId: `artbk-${Date.now()}`,
        owner: nftOwnerAccount,
        properties: { 
            edition: 1,
            artist: "AI Painter"
        },
        uri: "https://example.com/artbk/1.json"
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [authorizingAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'nft_mint',
                payload: mintData
            })
        }
    ];

    console.log('Attempting to broadcast NFT Mint operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('NFT Mint operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting NFT Mint operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 