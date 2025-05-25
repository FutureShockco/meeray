const { getClient, getRandomAccount, generateRandomLaunchpadOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual launchpadId from a created launchpad project
    const launchpadIdPlaceholder = `launchpad-${Date.now()}`; // This is just an example, use a real launchpad ID

    // Generate random contribution amount
    const { amount: contributionAmount } = generateRandomLaunchpadOperation();

    const participateData = {
        userId: username,
        launchpadId: launchpadIdPlaceholder,
        contributionAmount
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