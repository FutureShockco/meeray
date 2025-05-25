const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // For this example, we'll transfer to a specific account from .env
    const ACCOUNT_B_NAME = process.env.TEST_ACCOUNT_B_NAME || 'echelon-edison';

    const tokenTransferData = {
        symbol: "TESTTKN", // Should match an existing token
        to: ACCOUNT_B_NAME,
        amount: "100",
        memo: "Test transfer"
    };

    console.log(`Transferring tokens with account ${username}:`);
    console.log(JSON.stringify(tokenTransferData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_transfer',
            tokenTransferData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token transfer failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 