const { sendCustomJson } = require('./helpers.cjs');

async function testPoolClaimFees() {
  const username = process.env.STEEM_USERNAME || 'testuser';
  const wif = process.env.STEEM_WIF || '5J...'; // Replace with actual WIF
  
  console.log(`Testing pool claim fees with account: ${username}`);

  try {
    // Test data - you'll need to replace with actual pool ID
    const poolId = 'MRY_USD'; // Replace with actual pool ID from your system
    
    console.log(`1. Claiming fees from pool ${poolId}...`);
    
    const result = await sendCustomJson('pool_claim_fees', {
      poolId: poolId
    });
    
    if (result.success) {
      console.log('✅ Pool claim fees transaction sent successfully!');
      console.log('Transaction ID:', result.txid);
    } else {
      console.log('❌ Pool claim fees transaction failed:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Error testing pool claim fees:', error);
  }
}

// Run the test
testPoolClaimFees().catch(console.error);
