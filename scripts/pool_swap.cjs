const { getClient, getRandomAccount, generateRandomPoolOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // Get existing pools to find a real poolId
    const existingPools = await client.call('condenser_api', 'get_ssc_account', [process.env.SSC_ACCOUNT || 'echelon-ssc', 'liquidityPools']);
    let poolId = null;
    let selectedPool = null;
    
    if (existingPools && existingPools.liquidityPools && existingPools.liquidityPools.length > 0) {
        // Get the first available pool
        selectedPool = existingPools.liquidityPools[0];
        poolId = selectedPool._id;
        console.log(`Found existing pool: ${poolId}`);
        console.log(`Pool tokens: ${selectedPool.tokenA_symbol} / ${selectedPool.tokenB_symbol}`);
    } else {
        console.error('No existing pools found. Please create a pool first using pool_create.cjs');
        return;
    }

    // Generate random swap amounts with slippage protection
    const { amount: amountIn, minAmountOut } = generateRandomPoolOperation();

    // Use the actual tokens from the selected pool
    const poolSwapData = {
        amountIn,
        minAmountOut,
        poolId: poolId,
        tokenIn_symbol: selectedPool.tokenA_symbol,  // Use actual token from pool
        tokenOut_symbol: selectedPool.tokenB_symbol  // Use actual token from pool
    };

    console.log(`Performing swap with account ${username}:`);
    console.log(JSON.stringify(poolSwapData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_swap',
            poolSwapData,
            username,
            privateKey
        );
        
        console.log(`Successfully initiated swap: ${amountIn} ${poolSwapData.tokenIn_symbol} -> ${poolSwapData.tokenOut_symbol} in pool ${poolId}`);
        
    } catch (error) {
        console.error('Pool swap failed:', error.message);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 