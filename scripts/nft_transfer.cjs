const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // For this example, we'll transfer to a specific account from .env
    const NFT_RECEIVER = process.env.TEST_ACCOUNT_B_NAME || 'echelon-edison';

    // IMPORTANT: Replace with an actual instanceId of an NFT owned by the sender
    const instanceIdToTransfer = `artbk-${Date.now()}`; // This is just an example, use a real NFT ID

    const transferData = {
        collectionSymbol: "ARTBK", // Should match an existing collection
        instanceId: instanceIdToTransfer,
        to: NFT_RECEIVER,
        memo: `NFT transfer from ${username} to ${NFT_RECEIVER}`
    };

    console.log(`Transferring NFT with account ${username}:`);
    console.log(JSON.stringify(transferData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'nft_transfer',
            transferData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('NFT transfer failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 