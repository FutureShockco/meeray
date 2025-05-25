const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with actual orderId and pairId from a previously placed order
    const orderIdToCancel = `order-${Date.now()}`; // This is just an example, use a real order ID
    const pairIdOfOrder = `pair-${Date.now()}`; // This is just an example, use a real pair ID

    const cancelOrderData = {
        userId: username,
        orderId: orderIdToCancel,
        pairId: pairIdOfOrder
    };

    console.log(`Canceling market order with account ${username}:`);
    console.log(JSON.stringify(cancelOrderData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'market_cancel_order',
            cancelOrderData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Market order cancellation failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 