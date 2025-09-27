const { getClient, getMasterAccount, sendMultiCustomJson } = require('../helpers.cjs');
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

    const ops = []
    let l = 15

    for (let i = 0; i < 5; i++) {
        const payload = {
            collectionSymbol: collectionSymbol,
            // Don't provide instanceId - let it auto-generate
            owner: username,
            properties: {
                attributes: {
                    rarity: "Rare",
                    strength: Math.floor(Math.random() * 100),
                    intelligence: Math.floor(Math.random() * 100),
                    luck: Math.floor(Math.random() * 100)
                }
            },
            coverUrl: `https://img.drugwars.io/news/${l + 1}.png`,
            uri: `https://img.drugwars.io/news/index.json`
        };
        l++
        ops.push({ contractAction: 'nft_mint', payload });

    }
    console.log(`Minting NFT with account ${username}:`);

    try {
        await sendMultiCustomJson(
            client,
            sscId,
            ops,
            username,
            privateKey
        );

        console.log(`✅ NFT minted successfully!`);
        console.log(`NFT will be available for listing with auto-generated instanceId`);

    } catch (error) {
        console.error(`❌ NFT minting failed: ${error.message}`);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 