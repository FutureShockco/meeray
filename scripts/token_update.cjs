const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');
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
    const tokenUpdateData = {
        symbol: lastSymbol, // Should match an existing token
        name: "Updated Test Token",
        description: "Updated token description",
        logoUrl: "https://www.square.fr/wp-content/uploads/2020/07/Square_logo.jpg",
        websiteUrl: "https://example.com/updated"
    };

    console.log(`Updating token with account ${username}:`);
    console.log(JSON.stringify(tokenUpdateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'token_update',
            tokenUpdateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Token update failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 