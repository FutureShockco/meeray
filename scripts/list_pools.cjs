const { getClient } = require('./helpers.cjs');

async function main() {
    try {
        // Get client
        const { client, sscId } = await getClient();

        console.log('Fetching available liquidity pools...\n');

        // Get existing pools
        const existingPools = await client.call('condenser_api', 'get_ssc_account', [process.env.SSC_ACCOUNT || 'echelon-ssc', 'liquidityPools']);
        
        if (!existingPools || !existingPools.liquidityPools || existingPools.liquidityPools.length === 0) {
            console.log('No liquidity pools found.');
            console.log('To create a pool, run: node scripts/pool_create.cjs');
            return;
        }

        console.log(`Found ${existingPools.liquidityPools.length} liquidity pool(s):\n`);

        existingPools.liquidityPools.forEach((pool, index) => {
            console.log(`${index + 1}. Pool ID: ${pool._id}`);
            console.log(`   Tokens: ${pool.tokenA_symbol} / ${pool.tokenB_symbol}`);
            console.log(`   Fee Tier: ${pool.feeTier} basis points (${(pool.feeTier / 100).toFixed(2)}%)`);
            console.log(`   Status: ${pool.status || 'ACTIVE'}`);
            console.log(`   Created: ${pool.createdAt || 'Unknown'}`);
            
            if (pool.tokenA_reserve && pool.tokenB_reserve) {
                console.log(`   Reserves: ${pool.tokenA_reserve} ${pool.tokenA_symbol}, ${pool.tokenB_reserve} ${pool.tokenB_symbol}`);
            } else {
                console.log(`   Reserves: No liquidity yet`);
            }
            console.log('');
        });

        console.log('To swap tokens, use one of the pool IDs above in: node scripts/pool_swap.cjs');
        console.log('To add liquidity to a pool: node scripts/pool_add_liquidity.cjs');

    } catch (error) {
        console.error('Error fetching pools:', error.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
});
