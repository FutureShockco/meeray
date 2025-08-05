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

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Test data for a basic market trade (auto-routing)
        const basicTradeData = {
            trader: username,
            tokenIn: 'ECH',
            tokenOut: 'STEEM',
            amountIn: '1000000000',        // 10.000 ECH tokens (10 * 10^8 = 1000000000)
            minAmountOut: '8500',          // 8.500 STEEM tokens (8.5 * 10^3 = 8500)
            maxSlippagePercent: 15.0       // Maximum 15% slippage
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
            tokenIn: 'ECH',
            tokenOut: 'STEEM',
            amountIn: '500000000',         // 5.000 ECH tokens (5 * 10^8 = 500000000)
            minAmountOut: '4000',          // 4.000 STEEM tokens (4 * 10^3 = 4000)
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

    } catch (error) {
        console.error('Error in market trade test:', error);
    }
}

// Run the test
main().catch(console.error);
