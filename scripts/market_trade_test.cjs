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

        console.log('Testing unified market trade (AMM + Orderbook)...');
        console.log('Note: Using maxSlippagePercent is recommended over minAmountOut');
        console.log('This approach works with any token decimals without hardcoding amounts.\n');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Test data for a basic market trade (auto-routing)
        const basicTradeData = {
            trader: username,
            tokenIn: 'ECH@echelon-node1',      // Use full token identifier format
            tokenOut: 'STEEM@echelon-node1',   // Use full token identifier format
            amountIn: '100000000',             // 1.0 ECH (ECH has 8 decimals)
            maxSlippagePercent: 5.0            // Maximum 5% slippage (let system calculate minAmountOut)
            // minAmountOut: not specified - let the system calculate based on slippage
            // routes: undefined - let the system auto-route for best price
        };

        console.log(`Creating market trade with account ${username}:`);
        console.log(JSON.stringify(basicTradeData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            basicTradeData,
            username,
            privateKey
        );

        console.log('Basic market trade sent successfully!');

        // Test with specific routing
        console.log('\n--- Testing with specific routing ---');

        const routedTradeData = {
            trader: username,
            tokenIn: 'ECH@echelon-node1',      // Use full token identifier format
            tokenOut: 'STEEM@echelon-node1',   // Use full token identifier format  
            amountIn: '50000000',              // 0.5 ECH (0.5 * 10^8 = 50000000)
            maxSlippagePercent: 10.0,          // 10% slippage (let system calculate minAmountOut)
            routes: [
                {
                    type: 'AMM',
                    allocation: 70,  // 70% through AMM
                    details: {
                        poolId: 'ECH_STEEM_300'  // Format: token1_token2_feeTier (300 bps = 3% fee)
                    }
                },
                {
                    type: 'ORDERBOOK',
                    allocation: 30,  // 30% through orderbook
                    details: {
                        pairId: 'ECH-STEEM',     // Different format for orderbook pairs
                        side: 'BUY',
                        orderType: 'MARKET'
                    }
                }
            ]
        };

        console.log('Sending routed trade:');
        console.log(JSON.stringify(routedTradeData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            routedTradeData,
            username,
            privateKey
        );

        console.log('Routed market trade sent successfully!');

        // Example of using minAmountOut for precise control (advanced usage)
        console.log('\n--- Testing with precise minAmountOut control ---');
        console.log('Note: Only use minAmountOut if you know the exact token decimals and expected output');

        const preciseTradeData = {
            trader: username,
            tokenIn: 'ECH@echelon-node1',
            tokenOut: 'STEEM@echelon-node1',
            amountIn: '10000000',              // 0.1 ECH (small amount)
            minAmountOut: '1',                 // Accept as little as 0.001 STEEM (very loose for testing)
            // maxSlippagePercent: not specified when using minAmountOut
        };

        console.log('Sending precise trade:');
        console.log(JSON.stringify(preciseTradeData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            preciseTradeData,
            username,
            privateKey
        );

        console.log('Precise market trade sent successfully!');

    } catch (error) {
        console.error('Error in market trade test:', error);
    }
}

// Run the test
main().catch(console.error);
