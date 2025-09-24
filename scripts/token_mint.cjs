const { getClient, getMasterAccount,getRandomAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function mintTokens(symbol, to) {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const tokenMintData = {
        symbol: symbol, // Should match an existing token
        to: to,
        amount: "1000000"
    };

    console.log(`Minting tokens with account ${username}:`);

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_mint',
            tokenMintData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token minting failed.');
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
    await mintTokens(lastSymbol, "echelon-node1");
    await mintTokens(lastSymbol, "echelon-node2");

}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 

