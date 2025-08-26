const { getClient, getMasterAccount, generateRandomLaunchpadData, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Generate random launchpad data
    const launchData = generateRandomLaunchpadData();

    const launchTokenData = {
        userId: username,
        tokenName: launchData.tokenName,
        tokenSymbol: launchData.tokenSymbol,
        tokenPrecision: launchData.tokenPrecision,
        tokenMaxSupply: launchData.tokenMaxSupply,
        tokenInitialSupply: launchData.tokenInitialSupply,
        description: launchData.description,
        logoUrl: launchData.logoUrl,
        websiteUrl: launchData.websiteUrl,
        phase: launchData.phase,
        duration: launchData.duration,
        startBlock: launchData.startBlock,
        softCap: launchData.softCap,
        hardCap: launchData.hardCap,
        tokenPrice: launchData.tokenPrice,
        minInvestment: launchData.minInvestment,
        maxInvestment: launchData.maxInvestment,
        vestingSchedule: launchData.vestingSchedule
    };

    console.log(`Launching token with account ${username}:`);
    console.log(JSON.stringify(launchTokenData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'launchpad_launch_token',
            launchTokenData,
            username,
            privateKey
        );

        // Write the launchpad ID to lastLaunchpadId.txt after successful launch
        // The launchpad ID format is typically userId-tokenSymbol
        const launchpadId = `${username}-${launchData.tokenSymbol}`;
        const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
        fs.writeFileSync(launchpadIdFilePath, launchpadId);
        console.log(`Launchpad ID "${launchpadId}" written to lastLaunchpadId.txt`);

    } catch (error) {
        console.error('Token launch failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 