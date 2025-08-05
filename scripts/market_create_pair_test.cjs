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

        console.log('Creating trading pairs for orderbook...');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Create ECH-STEEM trading pair
        const echSteemPairData = {
            baseAssetSymbol: 'ECH',
            quoteAssetSymbol: 'STEEM',
            tickSize: '1000',           // 0.001 STEEM (3 decimals)
            lotSize: '10000000',        // 0.1 ECH (8 decimals)  
            minNotional: '100000',      // 0.1 STEEM minimum trade value
            initialStatus: 'TRADING',
            minTradeAmount: '100000',   // 0.1 STEEM
            maxTradeAmount: '100000000000' // 100,000 STEEM
        };

        console.log(`Creating ECH-STEEM trading pair with account ${username}:`);
        console.log(JSON.stringify(echSteemPairData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_create_pair',
            echSteemPairData,
            username,
            privateKey
        );

        console.log('ECH-STEEM trading pair created successfully!');

        // Create ECH-USDT trading pair
        const echUsdtPairData = {
            baseAssetSymbol: 'ECH',
            // baseAssetIssuer: now automatically set to sender for security
            quoteAssetSymbol: 'USDT',
            // quoteAssetIssuer: now automatically set to sender for security
            tickSize: '100',            // 0.01 USDT (assuming 2 decimals)
            lotSize: '10000000',        // 0.1 ECH (8 decimals)
            minNotional: '10000',       // 0.1 USDT minimum trade value
            initialStatus: 'TRADING',
            minTradeAmount: '10000',    // 0.1 USDT
            maxTradeAmount: '1000000000' // 10,000 USDT
        };

        console.log(`Creating ECH-USDT trading pair with account ${username}:`);
        console.log(JSON.stringify(echUsdtPairData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_create_pair',
            echUsdtPairData,
            username,
            privateKey
        );

        console.log('ECH-USDT trading pair created successfully!');

        // Create STEEM-USDT trading pair
        const steemUsdtPairData = {
            baseAssetSymbol: 'STEEM',
            // baseAssetIssuer: now automatically set to sender for security
            quoteAssetSymbol: 'USDT',
            // quoteAssetIssuer: now automatically set to sender for security
            tickSize: '100',            // 0.01 USDT
            lotSize: '1000',            // 1.0 STEEM (3 decimals)
            minNotional: '10000',       // 0.1 USDT minimum trade value
            initialStatus: 'TRADING',
            minTradeAmount: '10000',    // 0.1 USDT
            maxTradeAmount: '1000000000' // 10,000 USDT
        };

        console.log(`Creating STEEM-USDT trading pair with account ${username}:`);
        console.log(JSON.stringify(steemUsdtPairData, null, 2));

        await sendCustomJson(
            client,
            sscId,
            'market_create_pair',
            steemUsdtPairData,
            username,
            privateKey
        );

        console.log('STEEM-USDT trading pair created successfully!');
        console.log('\n✅ All trading pairs created! Now you can test hybrid trading with both AMM and orderbook routes.');

    } catch (error) {
        console.error('Error creating trading pairs:', error);
    }
}

// Run the test
main().catch(console.error);
