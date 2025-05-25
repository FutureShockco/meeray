const { getClient, getRandomAccount, generateRandomFarmOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual farmId from a created farm
    const farmIdPlaceholder = `farm-${Date.now()}`; // This is just an example, use a real farm ID

    // Generate random unstaking amount
    const { amount: unstakingAmount } = generateRandomFarmOperation();

    const farmUnstakeData = {
        farmId: farmIdPlaceholder,
        staker: username,
        unstakingAmount
    };

    console.log(`Unstaking from farm with account ${username}:`);
    console.log(JSON.stringify(farmUnstakeData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'farm_unstake',
            farmUnstakeData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Farm unstaking failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 