const { getClient, getRandomAccount, generateRandomFarmOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual farmId from a created farm
    const farmIdPlaceholder = `farm-${Date.now()}`; // This is just an example, use a real farm ID

    // Generate random staking amount
    const { amount: stakingAmount } = generateRandomFarmOperation();

    const farmStakeData = {
        farmId: farmIdPlaceholder,
        staker: username,
        stakingAmount
    };

    console.log(`Staking in farm with account ${username}:`);
    console.log(JSON.stringify(farmStakeData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'farm_stake',
            farmStakeData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Farm staking failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 