const { getClient } = require('./helpers.cjs');

async function main() {
    try {
        // Get command line arguments for token symbols
        const args = process.argv.slice(2);
        if (args.length !== 2) {
            console.log('Usage: node get_pool_for_tokens.cjs <tokenA_symbol> <tokenB_symbol>');
            console.log('Example: node get_pool_for_tokens.cjs TKA TKB');
            process.exit(1);
        }

        const tokenA = args[0].toUpperCase();
        const tokenB = args[1].toUpperCase();

        // Get client
        const { client, sscId } = await getClient();

        console.log(`Searching for pools containing ${tokenA} and ${tokenB}...\n`);

        // Get existing pools
        const existingPools = await client.call('condenser_api', 'get_ssc_account', [process.env.SSC_ACCOUNT || 'echelon-ssc', 'liquidityPools']);
        
        if (!existingPools || !existingPools.liquidityPools || existingPools.liquidityPools.length === 0) {
            console.log('No liquidity pools found.');
            console.log('To create a pool, run: node scripts/pool_create.cjs');
            return;
        }

        // Filter pools that contain both tokens
        const matchingPools = existingPools.liquidityPools.filter(pool => {
            return (pool.tokenA_symbol === tokenA && pool.tokenB_symbol === tokenB) ||
                   (pool.tokenA_symbol === tokenB && pool.tokenB_symbol === tokenA);
        });

        if (matchingPools.length === 0) {
            console.log(`No pools found containing both ${tokenA} and ${tokenB}.`);
            console.log('Available pools:');
            existingPools.liquidityPools.forEach((pool, index) => {
                console.log(`  ${index + 1}. ${pool._id}: ${pool.tokenA_symbol} / ${pool.tokenB_symbol}`);
            });
            return;
        }

        console.log(`Found ${matchingPools.length} pool(s) for ${tokenA} and ${tokenB}:\n`);

        matchingPools.forEach((pool, index) => {
            console.log(`${index + 1}. Pool ID: ${pool._id}`);
            console.log(`   Tokens: ${pool.tokenA_symbol} / ${pool.tokenB_symbol}`);
            console.log(`   Fee Tier: ${pool.feeTier} basis points (${(pool.feeTier / 100).toFixed(2)}%)`);
            console.log(`   Status: ${pool.status || 'ACTIVE'}`);
            
            if (pool.tokenA_reserve && pool.tokenB_reserve) {
                console.log(`   Reserves: ${pool.tokenA_reserve} ${pool.tokenA_symbol}, ${pool.tokenB_reserve} ${pool.tokenB_symbol}`);
            } else {
                console.log(`   Reserves: No liquidity yet`);
            }
            console.log('');
        });

        console.log(`To swap ${tokenA} for ${tokenB}, use one of the pool IDs above in your swap transaction.`);
        console.log(`Example: Update pool_swap.cjs to use poolId: "${matchingPools[0]._id}"`);

    } catch (error) {
        console.error('Error searching for pools:', error.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
});
