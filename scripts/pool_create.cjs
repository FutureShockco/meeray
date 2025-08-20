const { getClient, getMasterAccount, generateRandomPoolData, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getMasterAccount();

    // Generate random pool data
    const poolCreateData = {
        tokenA_symbol: "TESTS",
        tokenA_issuer: "echelon-node1",
        tokenB_symbol: "TBD",
        tokenB_issuer: "echelon-node1",
        feeTier: 300
    }

    console.log(`Creating pool with account ${username}:`);
    console.log(JSON.stringify(poolCreateData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'pool_create',
            poolCreateData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Pool creation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 