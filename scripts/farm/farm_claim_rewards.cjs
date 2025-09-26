const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Read the last created farm ID from file
    const farmIdFilePath = path.join(__dirname, 'lastFarmId.txt');
    let farmId = null;

    try {
        if (fs.existsSync(farmIdFilePath)) {
            farmId = fs.readFileSync(farmIdFilePath, 'utf8').trim();
            console.log(`Using last created farm ID: ${farmId}`);
        } else {
            console.error('No lastFarmId.txt found. Please run farm_create.cjs first.');
            return;
        }
    } catch (error) {
        console.error(`Error reading lastFarmId.txt: ${error.message}`);
        return;
    }

    const farmClaimData = {
        farmId: farmId,
        staker: username
    };

    console.log(`Claiming farm rewards with account ${username}:`);
    console.log(JSON.stringify(farmClaimData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'farm_claim_rewards',
            farmClaimData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Farm rewards claim failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 