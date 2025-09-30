const { getClient, getMasterAccount, generateRandomPoolOperation, generatePoolId, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const symbolFilePath = path.join(__dirname, '../lastTokenSymbol.txt');
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

    console.log(`Adding liquidity to pool with account ${username}:`);

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_add_liquidity',
            {
                poolId: generatePoolId("MRY", "TESTS"),
                tokenA_amount: "1000000000000", // 10000 MRY
                tokenB_amount: "1000000"       // 1000 TESTS
            },
            username,
            privateKey
        );
        await sendCustomJson(
            client,
            sscId,
            'pool_add_liquidity',
            {
                poolId: generatePoolId("MRY", "TBD"),
                tokenA_amount: "1000000000000", // 10000 MRY
                tokenB_amount: "100000"       // 100 TBD
            },
            username,
            privateKey
        );
        await sendCustomJson(
            client,
            sscId,
            'pool_add_liquidity',
            {
                poolId: generatePoolId("TBD", "TESTS"),
                tokenA_amount: "100000", // 1000 TBD
                tokenB_amount: "700000"       // 700 TESTS
            },
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool liquidity addition failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 