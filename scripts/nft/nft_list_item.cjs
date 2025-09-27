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

    // For now, use instanceId "1" as the first NFT in the collection
    // In a real scenario, you'd query the database to find the most recent NFT
    let instanceId = 3;
    console.log(`Using NFT instance ID: "${instanceId}" (first NFT in collection)`);
    console.log(`Looking for NFT: "${collectionSymbol}_${instanceId}"`);

    const listItemData = {
        collectionSymbol: collectionSymbol,
        instanceId: instanceId,
        price: "100000", // Fixed price for testing
        paymentToken: "TESTS", // Use TESTS token which should exist
    };

    console.log(`Listing NFT for sale with account ${username}:`);
    console.log(JSON.stringify(listItemData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_list_item',
            listItemData,
            username,
            privateKey
        );

        // Write the listing ID to lastNFTListingId.txt after successful listing
        // The listing ID format is collectionSymbol-instanceId-seller
        const listingId = `${collectionSymbol}_${instanceId}_${username}`;
        const listingIdFilePath = path.join(__dirname, 'lastNFTListingId.txt');
        fs.writeFileSync(listingIdFilePath, listingId);
        console.log(`NFT listing ID "${listingId}" written to lastNFTListingId.txt`);

    } catch (error) {
        console.error('NFT listing failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 