const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual listingId of an NFT listed by the account
    const listingIdToDelist = `listing-${Date.now()}`; // This is just an example, use a real listing ID

    const delistItemData = {
        listingId: listingIdToDelist
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