const { getClient, getRandomAccount, generateRandomNFTCollectionData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random NFT collection data
    const collectionData = generateRandomNFTCollectionData();
    
    // Add additional NFT-specific fields
    collectionData.creator = username;
    collectionData.mintable = true;
    collectionData.burnable = true;
    collectionData.transferable = true;
    collectionData.creatorFee = Math.floor(Math.random() * 10); // 0-10%
    collectionData.schema = JSON.stringify({
        type: "object",
        properties: {
            edition: { type: "integer" },
            artist: { type: "string" },
            attributes: { 
                type: "object",
                properties: collectionData.metadata.properties
            }
        }
    });

    console.log(`Creating NFT collection with account ${username}:`);
    console.log(JSON.stringify(collectionData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_create_collection',
            collectionData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT collection creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 