const { getClient, getRandomAccount, generateRandomPoolOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual poolId and ensure account has LP tokens for this pool
    const poolIdPlaceholder = `pool-${Date.now()}`; // This is just an example, use a real pool ID

    // Generate random LP token amount
    const { amount: lpTokenAmount } = generateRandomPoolOperation();

    const removeLiquidityData = {
        poolId: poolIdPlaceholder,
        provider: username,
        lpTokenAmount // Amount of LP tokens to burn/redeem
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