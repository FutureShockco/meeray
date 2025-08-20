const { getClient, getRandomAccount, getMasterAccount, generateRandomTokenData, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Generate random token data
    const tokenData = generateRandomTokenData();

    console.log(`Creating token with account ${username}:`);
    console.log(JSON.stringify(tokenData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_create',
            tokenData,
            username,
            privateKey
        );
        
        // Write the symbol to lastTokenSymbol.txt after successful creation
        const symbolFilePath = path.join(__dirname, 'lastTokenSymbol.txt');
        fs.writeFileSync(symbolFilePath, tokenData.symbol);
        console.log(`Token symbol "${tokenData.symbol}" written to lastTokenSymbol.txt`);
        
    } catch (error) {
        console.error('Token creation failed.');
        return; // Exit early if creation fails
    }

    // Read the symbol from lastTokenSymbol.txt for minting
    const symbolFilePath = path.join(__dirname, 'lastTokenSymbol.txt');
    let tokenSymbol;
    
    try {
        tokenSymbol = fs.readFileSync(symbolFilePath, 'utf8').trim();
        console.log(`Retrieved token symbol "${tokenSymbol}" from lastTokenSymbol.txt`);
    } catch (error) {
        console.error('Failed to read token symbol from lastTokenSymbol.txt:', error.message);
        return;
    }

    const tokenMintData = {
        symbol: tokenSymbol, // Use the retrieved symbol
        to: "echelon-node1",
        amount: tokenData.maxSupply / 10
    };

    console.log(`Minting tokens with account ${username}:`);
    console.log(JSON.stringify(tokenMintData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_mint',
            tokenMintData,
            username,
            privateKey
        );
        
        console.log(`Successfully minted ${tokenMintData.amount} ${tokenSymbol} to ${tokenMintData.to}`);
        
    } catch (error) {
        console.error('Token minting failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 