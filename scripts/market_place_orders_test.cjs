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

        console.log('Adding liquidity orders to ECH-STEEM orderbook...');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Place some limit orders to create market depth
        const orders = [
            // BUY orders (bids) - buying ECH with STEEM
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT',
                side: 'BUY',
                price: '900',           // 0.9 STEEM per ECH
                quantity: '100000000',  // 1.0 ECH
                timeInForce: 'GTC'
            },
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT', 
                side: 'BUY',
                price: '850',           // 0.85 STEEM per ECH
                quantity: '200000000',  // 2.0 ECH
                timeInForce: 'GTC'
            },
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT',
                side: 'BUY', 
                price: '800',           // 0.8 STEEM per ECH
                quantity: '500000000',  // 5.0 ECH
                timeInForce: 'GTC'
            },
            // SELL orders (asks) - selling ECH for STEEM
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT',
                side: 'SELL',
                price: '1000',          // 1.0 STEEM per ECH
                quantity: '100000000',  // 1.0 ECH
                timeInForce: 'GTC'
            },
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT',
                side: 'SELL',
                price: '1050',          // 1.05 STEEM per ECH
                quantity: '200000000',  // 2.0 ECH
                timeInForce: 'GTC'
            },
            {
                pairId: 'ECH-STEEM',
                type: 'LIMIT',
                side: 'SELL',
                price: '1100',          // 1.1 STEEM per ECH
                quantity: '300000000',  // 3.0 ECH
                timeInForce: 'GTC'
            }
        ];

        for (let i = 0; i < orders.length; i++) {
            const orderData = {
                userId: username,
                ...orders[i]
            };

            console.log(`\nPlacing order ${i + 1}/${orders.length}:`);
            console.log(JSON.stringify(orderData, null, 2));

            await sendCustomJson(
                client,
                sscId,
                'market_place_order',
                orderData,
                username,
                privateKey
            );

            console.log(`Order ${i + 1} placed successfully!`);
            
            // Small delay between orders
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('\n✅ All limit orders placed! ECH-STEEM orderbook now has liquidity.');
        console.log('\nOrderbook structure:');
        console.log('ASKS (selling ECH):');
        console.log('  1.10 STEEM - 3.0 ECH');
        console.log('  1.05 STEEM - 2.0 ECH'); 
        console.log('  1.00 STEEM - 1.0 ECH');
        console.log('BIDS (buying ECH):');
        console.log('  0.90 STEEM - 1.0 ECH');
        console.log('  0.85 STEEM - 2.0 ECH');
        console.log('  0.80 STEEM - 5.0 ECH');
        console.log('\nNow you can test hybrid trades with both AMM and orderbook liquidity!');

    } catch (error) {
        console.error('Error placing orders:', error);
    }
}

// Run the test
main().catch(console.error);
