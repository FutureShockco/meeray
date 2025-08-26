const { getClient, getMasterAccount, generateRandomPoolOperation, generatePoolId, sendCustomJson } = require('./helpers.cjs');
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

    // Generate random amounts for both tokens
    const tokenAOp = {
        amount: "10000",
        issuer: "echelon-node1"
    }
    const tokenBOp = {
        amount: "287000",
        issuer: "echelon-node1"
    }

    const addLiquidityData = {
        poolId: generatePoolId(lastSymbol, "TESTS", 300),
        provider: username,
        tokenA_amount: tokenAOp.amount,
        tokenB_amount: tokenBOp.amount
    };

    console.log(`Adding liquidity to pool with account ${username}:`);
    console.log(JSON.stringify(addLiquidityData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_add_liquidity',
            addLiquidityData,
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