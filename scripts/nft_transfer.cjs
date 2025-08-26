const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created NFT collection symbol and instance ID from files
    const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');
    const instanceIdFilePath = path.join(__dirname, 'lastNFTInstanceId.txt');

    let collectionSymbol = "TESTNFT"; // Default fallback
    let instanceId = null;

    try {
        if (fs.existsSync(symbolFilePath)) {
            collectionSymbol = fs.readFileSync(symbolFilePath, 'utf8').trim();
            console.log(`Using last created NFT collection symbol: ${collectionSymbol}`);
        } else {
            console.log(`No lastNFTCollectionSymbol.txt found, using default symbol: ${collectionSymbol}`);
        }
    } catch (error) {
        console.error(`Error reading lastNFTCollectionSymbol.txt: ${error.message}`);
        console.log(`Using default symbol: ${collectionSymbol}`);
    }

    try {
        if (fs.existsSync(instanceIdFilePath)) {
            instanceId = fs.readFileSync(instanceIdFilePath, 'utf8').trim();
            console.log(`Using last created NFT instance ID: ${instanceId}`);
        } else {
            console.error('No lastNFTInstanceId.txt found. Please run nft_mint.cjs first.');
            return;
        }
    } catch (error) {
        console.error(`Error reading lastNFTInstanceId.txt: ${error.message}`);
        return;
    }

    // For this example, we'll transfer to a different account (echelon-node2)
    const NFT_RECEIVER = 'echelon-node2';

    const transferData = {
        collectionSymbol: collectionSymbol,
        instanceId: instanceId,
        to: NFT_RECEIVER,
        memo: `NFT transfer from ${username} to ${NFT_RECEIVER}`
    };

    console.log(`Transferring NFT with account ${username}:`);
    console.log(JSON.stringify(transferData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_transfer',
            transferData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT transfer failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 