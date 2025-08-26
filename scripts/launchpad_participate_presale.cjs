const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created launchpad ID from file
    const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
    let launchpadId = null;

    try {
        if (fs.existsSync(launchpadIdFilePath)) {
            launchpadId = fs.readFileSync(launchpadIdFilePath, 'utf8').trim();
            console.log(`Using last created launchpad ID: ${launchpadId}`);
        } else {
            console.error('No lastLaunchpadId.txt found. Please run launchpad_launch_token.cjs first.');
            return;
        }
    } catch (error) {
        console.error(`Error reading lastLaunchpadId.txt: ${error.message}`);
        return;
    }

    const participateData = {
        userId: username,
        launchpadId: launchpadId,
        contributionAmount: "100000" // Fixed contribution amount
    };

    console.log(`Participating in presale with account ${username}:`);
    console.log(JSON.stringify(participateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'launchpad_participate_presale',
            participateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Presale participation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 