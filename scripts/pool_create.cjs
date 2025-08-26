const { getClient, getMasterAccount, generateRandomPoolData, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');


async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();
    const symbolFilePath = path.join(__dirname, 'lastTokenSymbol.txt');
    let lastSymbol = "TESTS"; // Default fallback

    try {
        if (fs.existsSync(symbolFilePath)) {
            lastSymbol = fs.readFileSync(symbolFilePath, 'utf8').trim();
            console.log(`Using last created token symbol: ${lastSymbol}`);
        } else {
            console.log(`No lastTokenSymbol.txt found, using default symbol: ${lastSymbol}`);
        }
    } catch (error) {
        console.error(`Error reading lastTokenSymbol.txt: ${error.message}`);
        console.log(`Using default symbol: ${lastSymbol}`);
    }
    // Generate random pool data
    const poolCreateData = {
        tokenA_symbol: "TESTS",
        tokenA_issuer: "echelon-node1",
        tokenB_symbol: lastSymbol,
        tokenB_issuer: "echelon-node1",
        feeTier: 300
    }

    console.log(`Creating pool with account ${username}:`);
    console.log(JSON.stringify(poolCreateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_create',
            poolCreateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 