const { getClient, getMasterAccount, generatePoolId, sendCustomJson } = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and master account
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

    const removeLiquidityData = {
        poolId: generatePoolId(lastSymbol, "TESTS", 300),
        user: username,
        lpTokenAmount: "5000" // Amount of LP tokens to burn/redeem
    };

    console.log(`Removing liquidity from pool with account ${username}:`);
    console.log(JSON.stringify(removeLiquidityData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_remove_liquidity',
            removeLiquidityData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool liquidity removal failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 