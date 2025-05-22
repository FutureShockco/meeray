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
        // This should be the key for 'echelon-darwin' or whichever account is listing the item.
        if (!privateKeysData || !Array.isArray(privateKeysData) || privateKeysData.length === 0) {
            console.error('Error: keys.json is missing, empty, or not an array.');
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error loading or parsing ${KEYS_FILE_PATH}:`, err.message);
        process.exit(1);
    }

    const signingPrivateKeyString = privateKeysData[0]; // IMPORTANT: This should be echelon-darwin's active key
    const sellerAccount = 'echelon-darwin'; // Account listing the NFT

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by sellerAccount
    const instanceIdToList = 'artbk-example-id-12345'; 

    const listItemData = {
        collectionSymbol: "ARTBK",
        instanceId: instanceIdToList,
        price: 100.50, // Sale price
        paymentTokenSymbol: "ECH", // Token for payment
        // paymentTokenIssuer: "some-issuer", // Required if paymentTokenSymbol is not NATIVE_TOKEN
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [sellerAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'nft_list_item',
                payload: listItemData
            })
        }
    ];

    console.log('Attempting to broadcast NFT List Item operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('NFT List Item operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting NFT List Item operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 