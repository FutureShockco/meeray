const { getClient, getMasterAccount, generateRandomNFTCollectionData, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const collectionData = {
        symbol: "DWD",
        name: "NFT Collection For Drugwars",
        mintable: true,
        burnable: true,
        transferable: true,
        royaltyBps: 1000, // 0-10%
        maxSupply: 8888,
        description: 'A unique digital collectibles series',
        logoUrl: `https://img.drugwars.io/news/6.png`,
        websiteUrl: `https://drugwars.io`,
        baseCoverUrl: `https://img.drugwars.io/news/2.png`,
    };

    console.log(`Creating NFT collection with account ${username}:`);

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_create_collection',
            collectionData,
            username,
            privateKey
        );

        console.log(`✅ NFT collection "${collectionData.symbol}" created successfully!`);
        const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');
        fs.writeFileSync(symbolFilePath, collectionData.symbol);
        console.log(`NFT collection symbol "${collectionData.symbol}" written to lastNFTCollectionSymbol.txt`);

    } catch (error) {
        console.error(`❌ NFT collection creation failed: ${error.message}`);
        console.error('Collection data:', JSON.stringify(collectionData, null, 2));
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 