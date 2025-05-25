const { getClient, getRandomAccount, generateRandomFarmData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random farm data
    const farmData = generateRandomFarmData();

    const farmCreateData = {
        farmType: farmData.farmType,
        stakingTokenSymbol: farmData.stakingTokenSymbol,
        stakingTokenIssuer: farmData.stakingTokenIssuer,
        rewardTokenSymbol: farmData.rewardTokenSymbol,
        rewardTokenIssuer: farmData.rewardTokenIssuer,
        rewardPerBlock: farmData.rewardPerBlock,
        rewardInterval: farmData.rewardInterval,
        multiplier: farmData.multiplier,
        maxStakingAmount: farmData.maxStakingAmount
    };

    console.log(`Creating farm with account ${username}:`);
    console.log(JSON.stringify(farmCreateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'farm_create',
            farmCreateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Farm creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 