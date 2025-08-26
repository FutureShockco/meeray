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

    const listItemData = {
        collectionSymbol: collectionSymbol,
        instanceId: instanceId,
        price: "100000", // Fixed price for testing
        paymentTokenSymbol: "TESTS", // Use TESTS token which should exist
        paymentTokenIssuer: "echelon-node1" // Issuer for TESTS token
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
        // The listing ID format is typically collectionSymbol-instanceId
        const listingId = `${collectionSymbol}-${instanceId}`;
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