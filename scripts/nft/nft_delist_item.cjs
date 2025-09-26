const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');
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

    // Generate listing ID based on collection symbol and instance ID
    let listingId = `${collectionSymbol}-1-${username}`; // Format: collection-instanceId-seller
    console.log(`Using NFT listing ID: ${listingId}`);

    const delistItemData = {
        listingId: listingId
    };

    console.log(`Delisting NFT with account ${username}:`);
    console.log(JSON.stringify(delistItemData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_delist_item',
            delistItemData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT delisting failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 