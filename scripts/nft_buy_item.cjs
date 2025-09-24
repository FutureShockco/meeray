const { getClient, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client - we'll use a different account to buy the NFT
    const { client, sscId } = await getClient();

    // Use echelon-node2 account to buy the NFT (different from the lister)
    const username = 'echelon-node2';
    const keys = require('./keys.json');
    const privateKey = keys[1]; // Use second key for echelon-node2

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
    let listingId = `${collectionSymbol}-1-echelon-node1`; // Format: collection-instanceId-seller (seller is echelon-node1)
    console.log(`Using NFT listing ID: ${listingId}`);

    const buyItemData = {
        listingId: listingId
    };

    console.log(`Buying NFT with account ${username}:`);
    console.log(JSON.stringify(buyItemData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_buy_item',
            buyItemData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT purchase failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 