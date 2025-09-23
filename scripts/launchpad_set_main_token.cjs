const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
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

    const payload = {
        userId: username,
        launchpadId,
        mainTokenId: `${launchpadId.split('_')[1] || 'MYT'}@meeray-node1`
    };

    try {
        await sendCustomJson(client, sscId, 'launchpad_set_main_token', payload, username, privateKey);
        console.log('Set main token for', launchpadId, 'to', payload.mainTokenId);
    } catch (err) {
        console.error('Failed to set main token:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
