const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    const tokenUpdateData = {
        symbol: "TESTTKN", // Should match an existing token
        name: "Updated Test Token",
        description: "Updated token description",
        logoUrl: "https://example.com/updated-logo.png",
        websiteUrl: "https://example.com/updated"
    };

    console.log(`Updating token with account ${username}:`);
    console.log(JSON.stringify(tokenUpdateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_update',
            tokenUpdateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token update failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 