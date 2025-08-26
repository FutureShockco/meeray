const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created NFT listing ID from file
    const listingIdFilePath = path.join(__dirname, 'lastNFTListingId.txt');
    let listingId = null;

    try {
        if (fs.existsSync(listingIdFilePath)) {
            listingId = fs.readFileSync(listingIdFilePath, 'utf8').trim();
            console.log(`Using last created NFT listing ID: ${listingId}`);
        } else {
            console.error('No lastNFTListingId.txt found. Please run nft_list_item.cjs first.');
            return;
        }
    } catch (error) {
        console.error(`Error reading lastNFTListingId.txt: ${error.message}`);
        return;
    }

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