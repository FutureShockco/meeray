const { getClient, getRandomAccount, sendCustomJson } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

async function main() {
    const { default: dsteem, PrivateKey } = await import('dsteem');

    try {
        let privateKeys;
        try {
            // Load private keys from external file that will be gitignored
            const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
            privateKeys = JSON.parse(keysFile);
        } catch (err) {
            console.error('Error loading keys.json file:', err);
            process.exit(1);
        }

        console.log('Testing market trade with specific price (LIMIT ORDERS)...');
        console.log('This will create limit orders that only execute at your specified price.\n');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "meeray-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Test 1: Limit order with specific price
        console.log('=== TEST 1: Limit Order with Specific Price ===');
        const limitTradeData = {
            tokenIn: 'MRY',      
            tokenOut: 'STEEM',   
            amountIn: '100000000',             // 1.0 MRY
            price: '50000000'                  // Price: 0.5 STEEM per MRY (adjust to 8 decimals: 0.5 * 10^8)
            // No slippage protection needed when using specific price
        };

        console.log('Creating limit order:');
        console.log(JSON.stringify(limitTradeData, null, 2));
        console.log('This will only execute if someone sells STEEM at 0.5 STEEM per MRY or better.');

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            limitTradeData,
            username,
            privateKey
        );

        console.log('✅ Limit order placed successfully!\n');

        // Test 2: Market order (old behavior for comparison)
        console.log('=== TEST 2: Market Order (executes immediately) ===');
        const marketTradeData = {
            tokenIn: 'MRY',      
            tokenOut: 'STEEM',   
            amountIn: '50000000',              // 0.5 MRY
            maxSlippagePercent: 5.0            // Will execute at current market price ±5%
            // No price specified = market order
        };

        console.log('Creating market order:');
        console.log(JSON.stringify(marketTradeData, null, 2));
        console.log('This will execute immediately at current market price.');

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            marketTradeData,
            username,
            privateKey
        );

        console.log('✅ Market order executed successfully!\n');

        // Test 3: Custom routing with price
        console.log('=== TEST 3: Custom Route with Specific Price ===');
        const customRouteData = {
            tokenIn: 'MRY',      
            tokenOut: 'STEEM',   
            amountIn: '75000000',              // 0.75 MRY
            price: '45000000',                 // Better price: 0.45 STEEM per MRY
            routes: [
                {
                    type: 'ORDERBOOK',
                    allocation: 100,  // 100% through orderbook with limit order
                    details: {
                        pairId: 'MRY-STEEM',
                        side: 'BUY',           // We're buying STEEM with MRY
                        orderType: 'LIMIT',
                        price: '45000000'      // Same price as in main data
                    }
                }
            ]
        };

        console.log('Creating custom route with limit price:');
        console.log(JSON.stringify(customRouteData, null, 2));
        console.log('This gives you full control over routing and price.');

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            customRouteData,
            username,
            privateKey
        );

        console.log('✅ Custom route limit order placed successfully!\n');

        console.log('=== SUMMARY ===');
        console.log('✅ Now you can specify exact prices for your trades!');
        console.log('📈 Use "price" field for limit orders that wait for your price');
        console.log('⚡ Use "maxSlippagePercent" for market orders that execute immediately');
        console.log('🎯 Limit orders will only execute when market reaches your price');

    } catch (error) {
        console.error('Error in market trade with price test:', error);
    }
}

// Run the test
main().catch(console.error);
