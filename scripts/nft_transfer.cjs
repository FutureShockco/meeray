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
        // Assuming keys.json contains an array of private keys
        // and the key for 'echelon-edison' is at a known index (e.g., index 1 if tesla is 0)
        // For this example, we'll still use privateKeysData[0] and assume it's edison's key for simplicity
        // In a real scenario, you'd fetch the correct key for the 'sender' account.
        if (!privateKeysData || !Array.isArray(privateKeysData) || privateKeysData.length === 0) {
            console.error('Error: keys.json is missing, empty, or not an array.');
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error loading or parsing ${KEYS_FILE_PATH}:`, err.message);
        process.exit(1);
    }

    const signingPrivateKeyString = privateKeysData[0]; // IMPORTANT: This should be the active key of 'echelon-edison'
    const currentOwnerAccount = 'echelon-edison';      // Current owner, authorizing the transfer
    const newOwnerAccount = 'echelon-darwin';          // New owner

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by currentOwnerAccount in the ARTBK collection
    const instanceIdToTransfer = 'artbk-example-id-12345'; 

    const transferData = {
        collectionSymbol: "ARTBK",
        instanceId: instanceIdToTransfer, 
        to: newOwnerAccount,
        memo: "Transferring my awesome art piece!"
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [currentOwnerAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'nft_transfer',
                payload: transferData
            })
        }
    ];

    console.log('Attempting to broadcast NFT Transfer operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('NFT Transfer operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting NFT Transfer operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 