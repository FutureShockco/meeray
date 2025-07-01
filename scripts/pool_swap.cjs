const { getClient, getRandomAccount, generateRandomPoolOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual poolId for the token pair
    const poolIdPlaceholder = `pool-${Date.now()}`; // This is just an example, use a real pool ID

    // Generate random swap amounts with slippage protection
    const { amount: amountIn, minAmountOut } = generateRandomPoolOperation();

    // For this example, we'll use a direct swap
    const poolSwapData = {
        amountIn,
        minAmountOut,
        poolId: poolIdPlaceholder,
        tokenInSymbol: "TKA",
        tokenInIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        tokenOutSymbol: "TKB",
        tokenOutIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer'
        // For a routed swap, you would use this structure instead:
        /*
        fromTokenSymbol: "TKA",
        fromTokenIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        toTokenSymbol: "TKC",
        toTokenIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
        hops: [
            {
                poolId: "pool-tka-tkb-example-id",
                hopTokenInSymbol: "TKA",
                hopTokenInIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
                hopTokenOutSymbol: "TKB",
                hopTokenOutIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer'
            },
            {
                poolId: "pool-tkb-tkc-example-id",
                hopTokenInSymbol: "TKB",
                hopTokenInIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer',
                hopTokenOutSymbol: "TKC",
                hopTokenOutIssuer: process.env.TOKEN_ISSUER || 'echelon-token-issuer'
            }
        ]
        */
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
    } catch (error) {
        console.error('Pool swap failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 