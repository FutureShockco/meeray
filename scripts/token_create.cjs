const { getClient, getRandomAccount, generateRandomTokenData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random token data
    const tokenData = generateRandomTokenData();

    console.log(`Creating token with account ${username}:`);
    console.log(JSON.stringify(tokenData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_create',
            tokenData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 