const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual listingId of an NFT for sale
    const listingIdToBuy = `listing-${Date.now()}`; // This is just an example, use a real listing ID

    const buyItemData = {
        listingId: listingIdToBuy
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