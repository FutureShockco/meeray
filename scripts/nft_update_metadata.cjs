const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created NFT collection symbol and instance ID from files
    const symbolFilePath = path.join(__dirname, 'lastNFTCollectionSymbol.txt');
    const instanceIdFilePath = path.join(__dirname, 'lastNFTInstanceId.txt');

    let collectionSymbol = "TESTNFT"; // Default fallback
    let instanceId = null;

    try {
        if (fs.existsSync(symbolFilePath)) {
            collectionSymbol = fs.readFileSync(symbolFilePath, 'utf8').trim();
            console.log(`Using last created NFT collection symbol: ${collectionSymbol}`);
        } else {
            console.log(`No lastNFTCollectionSymbol.txt found, using default symbol: ${collectionSymbol}`);
        }
    } catch (error) {
        console.error(`Error reading lastNFTCollectionSymbol.txt: ${error.message}`);
        console.log(`Using default symbol: ${collectionSymbol}`);
    }

    try {
        if (fs.existsSync(instanceIdFilePath)) {
            instanceId = fs.readFileSync(instanceIdFilePath, 'utf8').trim();
            console.log(`Using last created NFT instance ID: ${instanceId}`);
        } else {
            console.error('No lastNFTInstanceId.txt found. Please run nft_mint.cjs first.');
            return;
        }
    } catch (error) {
        console.error(`Error reading lastNFTInstanceId.txt: ${error.message}`);
        return;
    }

    const updateMetadataData = {
        collectionSymbol: collectionSymbol,
        instanceId: instanceId,
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
        uri: `https://example.com/nft/${collectionSymbol.toLowerCase()}/${Date.now()}_updated.json`
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