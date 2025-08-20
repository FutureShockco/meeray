const { getClient, getMasterAccount, generateRandomPoolOperation, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();


    // Generate random amounts for both tokens
    const tokenAOp = {
        amount: "90000",
        issuer: "echelon-node1"
    }
    const tokenBOp = {
        amount: "587000",
        issuer: "echelon-node1"
    }

    const addLiquidityData = {
        poolId: "TBD_TESTS_300",
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