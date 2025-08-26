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
    
    // Also mint some default tokens for testing
    await mintTokens("TESTS", "echelon-node1");
    await mintTokens("TBD", "echelon-node1");
    await mintTokens("TESTS", "echelon-node2");
    await mintTokens("TBD", "echelon-node2");
    await mintTokens("TESTS", "echelon-node1");
    await mintTokens("TBD", "echelon-node1");
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 

