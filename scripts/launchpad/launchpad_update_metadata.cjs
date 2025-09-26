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

    const payload = {
        userId: username,
        launchpadId,
        tokenDescription: 'Updated description via script',
        tokenLogoUrl: 'https://example.com/newlogo.png',
        projectSocials: { twitter: 'https://twitter.com/newhandle' }
    };

    try {
        await sendCustomJson(client, sscId, 'launchpad_update_metadata', payload, username, privateKey);
        console.log('Updated metadata for', launchpadId);
    } catch (err) {
        console.error('Failed to update metadata:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
