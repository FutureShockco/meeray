const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by the account
    const instanceIdToUpdate = `artbk-${Date.now()}`; // This is just an example, use a real NFT ID

    const updateMetadataData = {
        collectionSymbol: "ARTBK", // Should match an existing collection
        instanceId: instanceIdToUpdate,
        properties: { 
            artist: username,
            edition: Math.floor(Math.random() * 1000) + 1,
            attributes: {
                rarity: "Legendary", // Upgrade the rarity!
                strength: Math.floor(Math.random() * 100),
                intelligence: Math.floor(Math.random() * 100),
                luck: Math.floor(Math.random() * 100)
            }
        },
        uri: `https://example.com/nft/artbk/${Date.now()}_updated.json`
    };

    console.log(`Updating NFT metadata with account ${username}:`);
    console.log(JSON.stringify(updateMetadataData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_update_metadata',
            updateMetadataData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT metadata update failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 