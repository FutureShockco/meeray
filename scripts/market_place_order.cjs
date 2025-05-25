const { getClient, getRandomAccount, generateRandomMarketOrder, sendCustomJson } = require('./helpers.cjs');

async function main() {
    // Get client and random account
    const { client, sscId } = await getClient();
    const { username, privateKey } = await getRandomAccount();

    // IMPORTANT: Replace with an actual pairId from a created market pair
    const pairIdPlaceholder = `pair-${Date.now()}`; // This is just an example, use a real pair ID

    // Generate random order data
    const orderData = generateRandomMarketOrder();

    const placeOrderData = {
        userId: username,
        pairId: pairIdPlaceholder,
        type: orderData.type.toUpperCase(),
        side: orderData.side.toUpperCase(),
        price: orderData.price,         // Only for LIMIT orders
        quantity: orderData.amount,     // Base asset amount
        minAmountOut: orderData.minAmountOut, // Only for MARKET orders
        timeInForce: "GTC" // Good 'Til Canceled
    };

    console.log(`Placing market order with account ${username}:`);
    console.log(JSON.stringify(placeOrderData, null, 2));

    try {
        await sendCustomJson(
            client,
            sscId,
            'market_place_order',
            placeOrderData,
            username,
            privateKey
        );
    } catch (error) {
        console.error('Market order placement failed.');
    }
}

main().catch(err => {
    console.error("Error in main execution:", err.message);
    process.exit(1);
}); 