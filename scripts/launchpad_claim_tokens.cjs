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
    const userIdAccount = 'echelon-darwin'; 

    // IMPORTANT: Replace with an actual launchpadId and ensure the user participated
    const launchpadIdPlaceholder = "lpstr-launchpad-project-id-123";

    const claimData = {
        userId: userIdAccount,
        launchpadId: launchpadIdPlaceholder,
        allocationType: "PRESALE_INVESTORS" // Example: could be other types like "AIRDROP", "TEAM_VESTING", etc.
    };

    const customJsonOperation = [
        'custom_json',
        {
            required_auths: [userIdAccount],
            required_posting_auths: [],
            id: 'sidechain',
            json: JSON.stringify({
                contract: 'launchpad_claim_tokens',
                payload: claimData
            })
        }
    ];

    console.log('Attempting to broadcast Launchpad Claim Tokens operation:');
    console.log(JSON.stringify(customJsonOperation, null, 2));

    try {
        const result = await client.broadcast.sendOperations(
            [customJsonOperation],
            PrivateKey.fromString(signingPrivateKeyString)
        );
        console.log('Launchpad Claim Tokens operation broadcasted successfully!');
        console.log('Transaction ID:', result.id);
        console.log('Block Number:', result.block_num);
    } catch (error) {
        console.error('Error broadcasting Launchpad Claim Tokens operation:', error.message);
        if (error.data && error.data.stack) {
            console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 