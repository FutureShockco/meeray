const { getClient, getRandomAccount, generateRandomMarketPairData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Generate random market pair data
    const pairData = generateRandomMarketPairData();

    const createPairData = {
        baseAssetSymbol: pairData.baseSymbol,
        baseAssetIssuer: pairData.baseIssuer,
        quoteAssetSymbol: pairData.quoteSymbol,
        quoteAssetIssuer: pairData.quoteIssuer,
        tickSize: 0.0001, // Minimum price movement
        lotSize: 1,       // Minimum order quantity
        minNotional: 1,   // Minimum order value
        initialStatus: "TRADING"
    };

    console.log(`Creating market pair with account ${username}:`);
    console.log(JSON.stringify(createPairData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'market_create_pair',
            createPairData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Market pair creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 