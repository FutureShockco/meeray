const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function transferTokens(symbol, to) {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const tokenTransferData = {
        symbol: symbol, // Should match an existing token
        to: to,
        amount: "1000000",
        memo: "Test transfer"
    };

    console.log(`Transferring tokens with account ${username}:`);
    console.log(JSON.stringify(tokenTransferData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_transfer',
            tokenTransferData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token transfer failed.');
    }
}

async function main() {
    // Read the last created token symbol from file
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
    
    // Mint tokens using the last created symbol
    await transferTokens(lastSymbol, "echelon-node3");
    await transferTokens(lastSymbol, "echelon-node2");
    
    // Also mint some default tokens for testing
    // await transferTokens("TESTS", "echelon-node3");
    // await transferTokens("TBD", "echelon-node3");
    // await transferTokens("TESTS", "echelon-node2");
    // await transferTokens("TBD", "echelon-node2");
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 

