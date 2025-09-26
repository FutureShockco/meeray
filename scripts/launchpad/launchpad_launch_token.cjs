const { getClient, getMasterAccount, generateRandomLaunchpadData, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');
// use global fetch (Node 18+)

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Generate random launchpad data
    const launchData = generateRandomLaunchpadData();

    const launchTokenData = {
        tokenName: launchData.tokenName,
        tokenSymbol: launchData.tokenSymbol,
        tokenPrecision: launchData.tokenPrecision,
        totalSupply: "1000000000",  // Fixed total supply for launch
        tokenInitialSupply: launchData.tokenInitialSupply,
        description: launchData.description,
        logoUrl: launchData.logoUrl,
        websiteUrl: launchData.websiteUrl,
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

        // Attempt to discover the created launchpad by querying the HTTP API (port 3001)
        const apiBase = process.env.LAUNCHPAD_API_BASE || 'http://localhost:3001';
        const launchpadIdFilePath = path.join(__dirname, 'lastLaunchpadId.txt');
        try {
            const url = `${apiBase.replace(/\/$/, '')}/launchpad`;
            const res = await fetch(url);
            let pads = [];
            if (res.ok) pads = await res.json();
            // Heuristic: find the most recent pad launched by this user with matching token symbol
            const candidate = (Array.isArray(pads) ? pads.slice().reverse().find(p => p.issuer === username && p.tokenToLaunch && p.tokenToLaunch.symbol === launchData.tokenSymbol) : null);
            const launchpadId = candidate ? candidate._id : `${username}_${launchData.tokenSymbol}`;
            fs.writeFileSync(launchpadIdFilePath, launchpadId);
            console.log(`Launchpad ID "${launchpadId}" written to lastLaunchpadId.txt`);
        } catch (err) {
            console.warn('Warning: could not query launchpad HTTP API to discover created id. Falling back to fallback id.');
            const fallbackId = `${username}_${launchData.tokenSymbol}`;
            fs.writeFileSync(launchpadIdFilePath, fallbackId);
            console.log(`Fallback Launchpad ID "${fallbackId}" written to lastLaunchpadId.txt`);
        }

    } catch (error) {
        console.error('Token launch failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 