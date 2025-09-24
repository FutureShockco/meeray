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

        console.log('Testing FIXED market trade with proper output calculation...');
        console.log('This should now correctly track the actual swap output amounts.\n');

        // Get client and random account
        const { client, sscId } = await getClient();
        const username = "echelon-node1"; 
        const privateKey = PrivateKey.fromString(privateKeys[0]);

        // Test the fix: Market order that should now work correctly
        console.log('=== TEST: Market Order with Fixed Output Tracking ===');
        const fixedTradeData = {
            tokenIn: 'STEEM',      // Swapping STEEM for MRY  
            tokenOut: 'MRY',       // Should get MRY back
            amountIn: '5000',                    // 5000 STEEM (no decimal places)
            maxSlippagePercent: 10.0             // 10% slippage tolerance
        };

        console.log('Creating market trade:');
        console.log(JSON.stringify(fixedTradeData, null, 2));
        console.log('Expected behavior: Should execute successfully and return correct MRY amount');

        await sendCustomJson(
            client,
            sscId,
            'market_trade',
            fixedTradeData,
            username,
            privateKey
        );

        console.log('✅ Market trade sent successfully!');
        console.log('Check the logs to see if the output amount is now correctly calculated.');
        console.log('The swap should show the actual MRY received instead of the STEEM input amount.');

    } catch (error) {
        console.error('Error in fixed market trade test:', error);
    }
}

// Run the test
main().catch(console.error);
