const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
// use global fetch (Node 18+)

async function main() {
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
    if (!fs.existsSync(launchpadIdFilePath)) {
        console.error('No lastLaunchpadId.txt found. Run launchpad_launch_token.cjs first.');
        return;
    }
    const launchpadId = fs.readFileSync(launchpadIdFilePath, 'utf8').split('\n')[0].trim();

    // Allow overriding desired status via CLI arg or env var
    const desiredStatus = process.argv[2] || process.env.NEW_STATUS || 'PRESALE_ACTIVE';

    // Query current status from HTTP API to ensure we follow allowed transitions
    const apiBase = process.env.LAUNCHPAD_API_BASE || 'http://localhost:3001';
    let currentStatus = null;
    try {
        const url = `${apiBase.replace(/\/$/, '')}/launchpad/${encodeURIComponent(launchpadId)}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            currentStatus = data && data.status;
            console.log(`Current launchpad status: ${currentStatus}`);
        } else {
            console.error(`Could not fetch launchpad details, HTTP ${resp.status}`);
        }
    } catch (err) {
        console.error('Could not fetch launchpad details to determine current status:', err.message || err);
        // proceed but server may reject invalid transitions
    }

    // If current status is UPCOMING and desired is PRESALE_ACTIVE, first schedule the presale
    const twoStep = (currentStatus === 'UPCOMING' && desiredStatus === 'PRESALE_ACTIVE');

    const payload = {
        userId: username,
        launchpadId,
        newStatus: twoStep ? 'PRESALE_SCHEDULED' : desiredStatus,
        reason: 'Automated status update via script'
    };

    try {
        console.log('Sending status update:', payload.newStatus);
        await sendCustomJson(client, sscId, 'launchpad_update_status', payload, username, privateKey);
        console.log('Launchpad status update sent for', launchpadId, '->', payload.newStatus);

        if (twoStep) {
            // Wait briefly then attempt to activate
            await new Promise(r => setTimeout(r, 2000));
            const activatePayload = { userId: username, launchpadId, newStatus: 'PRESALE_ACTIVE', reason: 'Activating presale after scheduling' };
            console.log('Sending follow-up status update: PRESALE_ACTIVE');
            await sendCustomJson(client, sscId, 'launchpad_update_status', activatePayload, username, privateKey);
            console.log('Follow-up activation sent for', launchpadId);
        }
    } catch (err) {
        console.error('Failed to update status:', err.message);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
