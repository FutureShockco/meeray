const { getClient, getRandomAccount, generateRandomPoolOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual poolId from a created pool
    const poolIdPlaceholder = `pool-${Date.now()}`; // This is just an example, use a real pool ID

    // Generate random amounts for both tokens
    const tokenAOp = generateRandomPoolOperation();
    const tokenBOp = generateRandomPoolOperation();

    const addLiquidityData = {
        poolId: poolIdPlaceholder,
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