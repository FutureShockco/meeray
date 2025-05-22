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

    const signingPrivateKeyString = privateKeysData[0]; // This should be echelon-darwin's active key
    const authorizingAccount = 'echelon-darwin'; // Account owning the NFT and authorizing the update

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by authorizingAccount
    const instanceIdToUpdate = 'artbk-example-id-12345'; 

    const updateMetadataData = {
        collectionSymbol: "ARTBK",
        instanceId: instanceIdToUpdate,
        properties: { 
            artist: "Updated Artist Name",
            edition: 2 // Example of updating a property
        },
        uri: "https://example.com/artbk/1_updated.json" // Example of updating URI
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [authorizingAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'nft_update_metadata', 
                payload: updateMetadataData
            })
        }
    ];

    console.log('Attempting to broadcast NFT Update Metadata operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('NFT Update Metadata operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting NFT Update Metadata operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 