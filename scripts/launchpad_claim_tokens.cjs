const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual launchpadId and ensure the user participated
    const launchpadIdPlaceholder = `launchpad-${Date.now()}`; // This is just an example, use a real launchpad ID

    const claimData = {
        userId: username,
        launchpadId: launchpadIdPlaceholder,
        allocationType: "PRESALE_INVESTORS" // Example: could be other types like "AIRDROP", "TEAM_VESTING", etc.
    };

    console.log(`Claiming launchpad tokens with account ${username}:`);
    console.log(JSON.stringify(claimData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'launchpad_claim_tokens',
            claimData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token claim failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 