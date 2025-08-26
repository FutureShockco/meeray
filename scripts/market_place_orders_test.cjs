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

        console.log('Creating market liquidity using hybrid trading system...');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Note: The old orderbook-only system has been replaced with hybrid trading
        // Instead of placing individual orders, we now use market_trade which intelligently
        // routes through both AMM pools and orderbook for optimal execution
        
        // Create some sample hybrid trades to demonstrate the new system
        const hybridTrades = [
            // Example: Trade ECH for STEEM
            {
                trader: username,
                tokenIn: 'ECH@echelon-node1',
                tokenOut: 'STEEM@echelon-node1', 
                amountIn: '100000000', // 1.0 ECH (8 decimals)
                maxSlippagePercent: 2.0 // 2% max slippage
            },
            // Example: Trade STEEM for ECH
            {
                trader: username,
                tokenIn: 'STEEM@echelon-node1',
                tokenOut: 'ECH@echelon-node1',
                amountIn: '1000', // 1.0 STEEM (3 decimals)
                maxSlippagePercent: 2.0
            }
        ];

        console.log('\n📢 IMPORTANT: The market system has been upgraded!');
        console.log('• Old system: Individual orderbook orders (market_place_order)'); 
        console.log('• New system: Hybrid trading (market_trade) with smart routing');
        console.log('• Benefits: Automatic best price discovery across AMM + orderbook\n');

        for (let i = 0; i < hybridTrades.length; i++) {
            const tradeData = hybridTrades[i];

            console.log(`\nExample hybrid trade ${i + 1}/${hybridTrades.length}:`);
            console.log(JSON.stringify(tradeData, null, 2));

            // Execute the actual hybrid trades
            try {
                await sendCustomJson(
                    client,
                    sscId,
                    'market_trade',
                    tradeData,
                    username,
                    privateKey
                );

                console.log(`✅ Hybrid trade ${i + 1} executed successfully!`);

                // Small delay between trades
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.log(`⚠️  Hybrid trade ${i + 1} failed:`, error.message);
            }
        }

        console.log('\n✅ Hybrid trading examples prepared!');
        console.log('\nHow the new system works:');
        console.log('1. Submit a market_trade transaction with tokenIn/tokenOut');
        console.log('2. System automatically finds best route across:');
        console.log('   • AMM pools (if available)');
        console.log('   • Orderbook liquidity (if available)');
        console.log('3. Optimal execution with minimal slippage');
        console.log('\nTo execute real trades, uncomment the sendCustomJson calls above.');
        console.log('\nFor order cancellation, use market_cancel_order transaction type.');

    } catch (error) {
        console.error('Error placing orders:', error);
    }
}

// Run the test
main().catch(console.error);
