const { getClient, getRandomAccount, generateRandomPoolData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random pool data
    const poolCreateData = generateRandomPoolData();

    console.log(`Creating pool with account ${username}:`);
    console.log(JSON.stringify(poolCreateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_create',
            poolCreateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 