const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by the account
    const instanceIdToList = `artbk-${Date.now()}`; // This is just an example, use a real NFT ID

    const listItemData = {
        collectionSymbol: "ARTBK", // Should match an existing collection
        instanceId: instanceIdToList,
        price: (BigInt(Math.floor(Math.random() * 100000) + 10000)).toString(), // Random price, as integer string
        paymentTokenSymbol: "ECH", // Token for payment
        // paymentTokenIssuer: "some-issuer", // Required if paymentTokenSymbol is not NATIVE_TOKEN
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
    } catch (error) {
        console.error('NFT listing failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 