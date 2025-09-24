const { getClient, getSecondAccount, generateRandomPoolOperation, generatePoolId, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getSecondAccount();

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_add_liquidity',
            {
                poolId: generatePoolId("TBD", "TESTS"),
                tokenA_amount: "100000", // 1000 TBD
                tokenB_amount: "100000"       // 100 TESTS
            },
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