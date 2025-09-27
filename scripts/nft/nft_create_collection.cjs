const { getClient, getMasterAccount, generateRandomNFTCollectionData, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Generate random NFT collection data
    const collectionData = generateRandomNFTCollectionData();
    
    // Add additional NFT-specific fields
    collectionData.creator = username;
    collectionData.mintable = true;
    collectionData.burnable = true;
    collectionData.transferable = true;
    collectionData.royaltyBps = Math.floor(Math.random() * 10); // 0-10%

    // Ensure maxSupply is a string, not a number
    collectionData.maxSupply = collectionData.maxSupply.toString();

    // Add optional fields that were generated but not explicitly set
    collectionData.description = collectionData.description || `${collectionData.name} - A unique digital collectibles series`;
    collectionData.logoUrl = collectionData.logoUrl || `https://example.com/nft/${collectionData.symbol.toLowerCase()}.png`;
    collectionData.websiteUrl = collectionData.websiteUrl || `https://example.com/nft/${collectionData.symbol.toLowerCase()}`;

    // Remove properties field - it should go in schema if needed
    delete collectionData.properties;
    delete collectionData.metadata;

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

        console.log(`✅ NFT collection "${collectionData.symbol}" created successfully!`);

        // Write the collection symbol to lastNFTCollectionSymbol.txt after successful creation
        const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');
        fs.writeFileSync(symbolFilePath, collectionData.symbol);
        console.log(`NFT collection symbol "${collectionData.symbol}" written to lastNFTCollectionSymbol.txt`);

    } catch (error) {
        console.error(`❌ NFT collection creation failed: ${error.message}`);
        console.error('Collection data:', JSON.stringify(collectionData, null, 2));
        // Don't write to file if creation failed
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 