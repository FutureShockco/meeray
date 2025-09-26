const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

// Note: requires Node 18+ for global fetch. If using older Node, install node-fetch.

async function main() {
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
    // Allow override via CLI arg or environment variable
    const overrideId = process.argv[2] || process.env.LAUNCHPAD_ID;
    let launchpadId = overrideId;
    if (!launchpadId) {
        if (!fs.existsSync(launchpadIdFilePath)) {
            console.error('No lastLaunchpadId.txt found. Pass the launchpad id as the first arg or set LAUNCHPAD_ID env var.');
            return;
        }
        launchpadId = fs.readFileSync(launchpadIdFilePath, 'utf8').split('\n')[0].trim();
    }

    // Quick sanity check: ensure the HTTP API knows about this launchpad before broadcasting
    try {
        const apiUrl = process.env.LAUNCHPAD_API_BASE || 'http://localhost:3001';
        const url = `${apiUrl.replace(/\/$/, '')}/launchpad/${encodeURIComponent(launchpadId)}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            if (resp.status === 404) {
                console.error(`Launchpad ${launchpadId} not found (404). Ensure the launchpad was created and that you passed the correct id.`);
                return;
            }
            console.error(`Launchpad ${launchpadId} not found (HTTP ${resp.status}). Aborting broadcast.`);
            return;
        }
    } catch (err) {
        console.error('Could not verify launchpad existence via HTTP API:', err.message || err);
        console.error('Proceeding may result in a validation failure. Aborting.');
        return;
    }

    // Example: ADD addresses
    const addPayload = {
        userId: username,
        launchpadId,
        action: 'ADD',
        addresses: ['bob', 'charlie']
    };

    // Example: ENABLE whitelist only
    const enablePayload = {
        userId: username,
        launchpadId,
        action: 'ENABLE'
    };

    try {
        console.log('Adding addresses to whitelist...');
        await sendCustomJson(client, sscId, 'launchpad_update_whitelist', addPayload, username, privateKey);

        console.log('Enabling whitelist...');
        await sendCustomJson(client, sscId, 'launchpad_update_whitelist', enablePayload, username, privateKey);

        console.log('Whitelist update completed for', launchpadId);
    } catch (err) {
        console.error('Failed to update whitelist:', err.message || err);
    }
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
