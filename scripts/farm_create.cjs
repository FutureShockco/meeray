const { getClient, getRandomAccount, generateRandomFarmData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random farm data
    const farmData = generateRandomFarmData();

    const now = Date.now();
    const durationMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const farmCreateData = {
        name: `Farm ${farmData.stakingTokenSymbol}-${farmData.rewardTokenSymbol}`,
        stakingToken: {
            symbol: `LP_${[farmData.stakingTokenSymbol, farmData.rewardTokenSymbol].sort().join('_')}_300`,
            issuer: `${[farmData.stakingTokenSymbol, farmData.rewardTokenSymbol].sort().join('_')}_300` // poolId convention
        },
        rewardToken: {
            symbol: farmData.rewardTokenSymbol,
            issuer: farmData.rewardTokenIssuer
        },
        startTime: new Date(now).toISOString(),
        endTime: new Date(now + durationMs).toISOString(),
        totalRewards: BigInt(farmData.rewardPerBlock) * BigInt(Math.floor(durationMs / 3000)),
        rewardsPerBlock: farmData.rewardPerBlock,
        minStakeAmount: '0',
        maxStakeAmount: '0'
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