const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created NFT collection symbol from file
    const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');

    let collectionSymbol = "TESTNFT"; // Default fallback

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

    // Use instanceId "1" as the first NFT in the collection
    let instanceId = "1";
    console.log(`Using NFT instance ID: "${instanceId}" (first NFT in collection)`);

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