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

    let l = 0; // Starting index
    const L = 1000; // Target limit
    const BATCH_SIZE = 5; // Number of NFTs per batch
    const DELAY_MS = 3000; // 3 seconds between batches

    let totalMinted = 0;
    let batchCount = 0;

    console.log(`Starting NFT minting process for collection: ${collectionSymbol}`);
    console.log(`Will mint NFTs in batches of ${BATCH_SIZE} every ${DELAY_MS / 1000} seconds until reaching ${L} total NFTs`);

    while (l < L) {
        const ops = [];
        const batchStart = l;

        // Create batch of up to BATCH_SIZE NFTs
        for (let i = 0; i < BATCH_SIZE && l < L; i++) {
            const payload = {
                collectionSymbol: collectionSymbol,
                // Don't provide instanceId - let it auto-generate
                owner: username,
                metadata: {
                    attributes: {
                        rarity: "Rare",
                        strength: Math.floor(Math.random() * 100),
                        intelligence: Math.floor(Math.random() * 100),
                        luck: Math.floor(Math.random() * 100)
                    }
                },
                coverUrl: `https://img.drugwars.io/news/${i + 1}.png`,
                uri: `https://img.drugwars.io/news/index.json`
            };
            l++;
            ops.push({ contractAction: 'nft_mint', payload });
        }

        batchCount++;
        console.log(`\n[Batch ${batchCount}] Minting ${ops.length} NFTs (${batchStart + 1} to ${l}) with account ${username}...`);

        try {
            await sendMultiCustomJson(
                client,
                sscId,
                ops,
                username,
                privateKey
            );

            totalMinted += ops.length;
            console.log(`✅ Batch ${batchCount} minted successfully! Total minted: ${totalMinted}/${L}`);

            // Wait 3 seconds before next batch (unless we're done)
            if (l < L) {
                console.log(`⏳ Waiting ${DELAY_MS / 1000} seconds before next batch...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }

        } catch (error) {
            console.error(`❌ Batch ${batchCount} minting failed: ${error.message}`);
            console.error(`Failed at NFT index ${batchStart}. Stopping process.`);
            throw error;
        }
    }

    console.log(`\n🎉 All done! Successfully minted ${totalMinted} NFTs in ${batchCount} batches.`);
    console.log(`NFTs will be available for listing with auto-generated instanceIds`);
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 