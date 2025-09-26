const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
    if (!fs.existsSync(launchpadIdFilePath)) {
        console.error('No lastLaunchpadId.txt found. Run launchpad_launch_token.cjs first.');
        return;
    }
    const launchpadId = fs.readFileSync(launchpadIdFilePath, 'utf8').trim();

    const tokenomics = {
        totalSupply: "100000000000000000",
        tokenDecimals: 8,
        allocations: [
            { recipient: "PRESALE_PARTICIPANTS", percentage: 30 },
            { recipient: "LIQUIDITY_POOL", percentage: 15 },
            { recipient: "PROJECT_TEAM", percentage: 20, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 12, cliffMonths: 3 } },
            { recipient: "AIRDROP_REWARDS", percentage: 5 }
        ]
    };

    const payload = {
        userId: username,
        launchpadId,
        tokenomics
    };

    try {
        await sendCustomJson(client, sscId, 'launchpad_configure_tokenomics', payload, username, privateKey);
        console.log('Tokenomics configured for', launchpadId);
    } catch (err) {
        console.error('Failed to configure tokenomics:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
