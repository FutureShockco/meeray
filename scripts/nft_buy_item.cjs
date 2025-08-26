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