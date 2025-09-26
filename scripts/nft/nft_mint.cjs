const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created NFT collection symbol from file
    const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');
    let collectionSymbol = "TESTNFT"; // Default fallback

    try {
        if (fs.existsSync(symbolFilePath)) {
            const fileContent = fs.readFileSync(symbolFilePath, 'utf8').trim();
            if (fileContent && fileContent.length > 0) {
                collectionSymbol = fileContent;
                console.log(`Using last created NFT collection symbol from file: "${collectionSymbol}"`);
            } else {
                console.log(`lastNFTCollectionSymbol.txt is empty, using default symbol: ${collectionSymbol}`);
            }
        } else {
            console.log(`No lastNFTCollectionSymbol.txt found, using default symbol: ${collectionSymbol}`);
        }
    } catch (error) {
        console.error(`Error reading lastNFTCollectionSymbol.txt: ${error.message}`);
        console.log(`Using default symbol: ${collectionSymbol}`);
    }

    const mintData = {
        collectionSymbol: collectionSymbol,
        // Don't provide instanceId - let it auto-generate
        owner: username, // Mint to the master account so we can transfer it later
        properties: {
            edition: Math.floor(Math.random() * 1000) + 1,
            artist: username,
            attributes: {
                rarity: "Rare",
                strength: Math.floor(Math.random() * 100),
                intelligence: Math.floor(Math.random() * 100),
                luck: Math.floor(Math.random() * 100)
            }
        },
        uri: `https://example.com/nft/${collectionSymbol.toLowerCase()}/${Date.now()}.json`
    };

    console.log(`Minting NFT with account ${username}:`);
    console.log(JSON.stringify(mintData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_mint',
            mintData,
            username,
            privateKey
        );

        console.log(`✅ NFT minted successfully!`);
        console.log(`NFT will be available for listing with auto-generated instanceId`);

    } catch (error) {
        console.error(`❌ NFT minting failed: ${error.message}`);

        // If collection doesn't exist, try to create it first
        if (error.message.includes('Collection') && error.message.includes('not found')) {
            console.log(`🔄 Collection "${collectionSymbol}" not found. Creating it first...`);

            const collectionData = {
                name: `${collectionSymbol} Collection`,
                symbol: collectionSymbol,
                description: `${collectionSymbol} - A test NFT collection`,
                logoUrl: `https://example.com/nft/${collectionSymbol.toLowerCase()}.png`,
                websiteUrl: `https://example.com/nft/${collectionSymbol.toLowerCase()}`,
                maxSupply: "10000",
                creator: username,
                mintable: true,
                burnable: true,
                transferable: true,
                creatorFee: 5
            };

            try {
                await sendCustomJson(
                    client,
                    sscId,
                    'nft_create_collection',
                    collectionData,
                    username,
                    privateKey
                );

                console.log(`✅ Collection "${collectionSymbol}" created successfully!`);

                // Now try minting again
                await sendCustomJson(
                    client,
                    sscId,
                    'nft_mint',
                    mintData,
                    username,
                    privateKey
                );

                console.log(`✅ NFT minted successfully after creating collection!`);
                console.log(`NFT will be available for listing with auto-generated instanceId`);

            } catch (createError) {
                console.error(`❌ Failed to create collection or mint NFT: ${createError.message}`);
            }
        }
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 