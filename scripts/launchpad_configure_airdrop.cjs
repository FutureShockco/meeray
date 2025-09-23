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

    const recipients = [
        { username: 'bob', amount: '1000000000' },
        { username: 'charlie', amount: '2000000000' }
    ];

    const payload = {
        userId: username,
        launchpadId,
        recipients
    };

    try {
        await sendCustomJson(client, sscId, 'launchpad_configure_airdrop', payload, username, privateKey);
        console.log('Airdrop configured for', launchpadId);
    } catch (err) {
        console.error('Failed to configure airdrop:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
