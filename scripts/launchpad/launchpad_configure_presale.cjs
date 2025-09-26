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

    const presaleDetails = {
        pricePerToken: "1000000",
        quoteAssetForPresaleSymbol: "STEEM",
        minContributionPerUser: "1000000",
        maxContributionPerUser: "100000000",
        startTime: new Date(Date.now() + 24*60*60*1000).toISOString(),
        endTime: new Date(Date.now() + 7*24*60*60*1000).toISOString(),
        hardCap: "10000000000",
        softCap: "1000000000",
        whitelistRequired: false,
        fcfsAfterReservedAllocation: true
    };

    const payload = {
        userId: username,
        launchpadId,
        presaleDetails
    };

    try {
        await sendCustomJson(client, sscId, 'launchpad_configure_presale', payload, username, privateKey);
        console.log('Presale configured for', launchpadId);
    } catch (err) {
        console.error('Failed to configure presale:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
