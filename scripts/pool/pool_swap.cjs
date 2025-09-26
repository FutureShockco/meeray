const { getClient, getMasterAccount, sendCustomJson } = require('../helpers.cjs');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const swapData = {
        fromTokenSymbol: "TESTS",
        toTokenSymbol: "TBD",
        amountIn: "10000",
        slippagePercent: 2.0  // 2% slippage tolerance for auto-route
    };

    console.log(`Swapping tokens in pool with account ${username}:`);
    console.log(JSON.stringify(swapData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_swap',
            swapData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool swap failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
});
