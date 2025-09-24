const fs = require('fs');
const path = require('path');
const { PrivateKey } = require('dsteem');
const { getClient,transfer,sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const username = "echelon-node2"
    let privateKeys;
    try {
        // Load private keys from external file that will be gitignored
        const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
        privateKeys = JSON.parse(keysFile);
    } catch (err) {
        console.error('Error loading keys.json file:', err);
        process.exit(1);
    }

    try {
        await transfer(
            client,
            username,
            'echelon-node1',
            '1.789 TESTS',
            username,
            PrivateKey.fromString(privateKeys[1])
        );
    } catch (error) {
        console.error('Token creation failed.');
    }

    const tokenWithdrawData = {
        symbol: 'TESTS',
        amount: '1289'
    };

    setTimeout(async () => {

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_withdraw',
            tokenWithdrawData,
            username,
            PrivateKey.fromString(privateKeys[1])
        );
    } catch (error) {
        console.error('Farm creation failed.');
    }
    }, 3000);

}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 