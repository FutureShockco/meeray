const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and master account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    const removeLiquidityData = {
        poolId: "TBD_TESTS_300",
        provider: username,
        lpTokenAmount: "10000" // Amount of LP tokens to burn/redeem
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