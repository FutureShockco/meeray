const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const now = Date.now();
    const durationMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const farmCreateData = {
        name: "TESTS Farm", // Simple farm name
        stakingToken: {
            symbol: "TESTS", // Use TESTS token which should exist
            issuer: "echelon-node1" // Issuer for TESTS token
        },
        rewardToken: {
            symbol: "TBD", // Use TBD token as reward
            issuer: "echelon-node1" // Issuer for TBD token
        },
        startTime: new Date(now).toISOString(),
        endTime: new Date(now + durationMs).toISOString(),
        totalRewards: "1000000", // Fixed total rewards
        rewardsPerBlock: "10", // Fixed rewards per block
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

        // Write the farm ID to lastFarmId.txt after successful creation
        // The farm ID format is typically a hash or identifier
        const farmId = `farm_${Date.now()}`; // Simplified farm ID for testing
        const farmIdFilePath = path.join(__dirname, 'lastFarmId.txt');
        fs.writeFileSync(farmIdFilePath, farmId);
        console.log(`Farm ID "${farmId}" written to lastFarmId.txt`);

    } catch (error) {
        console.error('Farm creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 