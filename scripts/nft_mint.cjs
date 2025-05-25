const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // For this example, we'll mint to a specific account from .env
    const NFT_OWNER = process.env.TEST_ACCOUNT_B_NAME || 'echelon-edison';

    const mintData = {
        collectionSymbol: "ARTBK", // Should match an existing collection
        instanceId: `artbk-${Date.now()}`,
        owner: NFT_OWNER,
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
        uri: `https://example.com/nft/artbk/${Date.now()}.json`
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
    } catch (error) {
        console.error('NFT minting failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 