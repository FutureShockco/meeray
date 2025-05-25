const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual farmId from a created farm
    const farmIdPlaceholder = `farm-${Date.now()}`; // This is just an example, use a real farm ID

    const farmClaimData = {
        farmId: farmIdPlaceholder,
        staker: username
    };

    console.log(`Claiming farm rewards with account ${username}:`);
    console.log(JSON.stringify(farmClaimData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'farm_claim_rewards',
            farmClaimData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Farm rewards claim failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 