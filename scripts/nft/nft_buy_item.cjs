const { getClient, sendCustomJson, getSecondAccount } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client - we'll use a different account to buy the NFT
    const { client, sscId } = await getClient();
    const {username, privateKey} = await getSecondAccount();

    const lastNFTListing = path.join(__dirname, 'lastNFTListingId.txt');
    let lastNFTListingId = "NFTLISTING_1"; // Default fallback
    try {
        if (fs.existsSync(lastNFTListing)) {
            lastNFTListingId = fs.readFileSync(lastNFTListing, 'utf8').trim();
            console.log(`Using last created NFT collection symbol: ${lastNFTListingId}`);
        } else {
            console.log(`No lastNFTListingId.txt found, using default symbol: ${lastNFTListingId}`);
        }
    } catch (error) {
        console.error(`Error reading lastNFTListingId.txt: ${error.lastNFTListing}`);
    }

    console.log(`Using NFT listing ID: ${lastNFTListingId}`);

    const buyItemData = {
        listingId: lastNFTListingId
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