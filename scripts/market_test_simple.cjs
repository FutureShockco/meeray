/**
 * Simple Market Trade Test Script
 * 
 * This script tests basic market trading functionality using the MeeRay hybrid system.
 * Uses the same helper structure as other project scripts for consistency.
 * 
 * Configuration:
 * - Accounts loaded from helpers.cjs (getMasterAccount)
 * - TOKEN_IN & TOKEN_OUT: The token pair to test
 * - TEST_AMOUNTS: Different amounts for testing
 * 
 * Features:
 * - Market order with auto-routing
 * - Limit order placement  
 * - MinAmountOut protection test
 * 
 * Requirements:
 * - Valid keys.json file with account credentials
 * - MeeRay node running locally
 * 
 * Expected behavior: Quick validation of core trading features
 */

const { getClient, getMasterAccount, sendCustomJson } = require('./helpers.cjs');

// Configuration
const TOKEN_IN = 'MRY';
const TOKEN_OUT = 'STEEM';
const TEST_AMOUNTS = {
  SMALL: '1000000000', // 10 tokens (8 decimals)
  MEDIUM: '2000000000' // 20 tokens
};
const SLIPPAGE = 1.0; // 1% slippage tolerance

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testMarketTrade() {
  console.log('🚀 Testing MeeRay Hybrid Market Trade');
  console.log('=====================================');
  
  // Get client and account using helpers
  const { client, sscId } = await getClient();
  const { username, privateKey } = await getMasterAccount();
  
  console.log(`🔑 Using account: ${username}`);
  
  try {
    // Test 1: Market Order with Auto-Routing
    console.log('📈 Test 1: Market Order with Auto-Routing');
    
    const marketTradeData = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: TEST_AMOUNTS.SMALL,
      maxSlippagePercent: SLIPPAGE
    };
    
    console.log('Submitting market trade transaction...');
    const result1 = await sendCustomJson(
      client,
      sscId,
      'hybrid_trade',
      marketTradeData,
      username,
      privateKey
    );
    
    console.log('✅ Market trade submitted:', result1.id);
    
    // Wait before next test
    await delay(5000);
    
    // Test 2: Limit Order
    console.log('📊 Test 2: Limit Order');
    
    const limitTradeData = {
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amountIn: TEST_AMOUNTS.SMALL,
      price: '50000000' // Fixed price (0.5 with 8 decimals)
    };
    
    console.log('Submitting limit order...');
    const result2 = await sendCustomJson(
      client,
      sscId,
      'hybrid_trade',
      limitTradeData,
      username,
      privateKey
    );
    
    console.log('✅ Limit order submitted:', result2.id);
    
    // Wait before next test
    await delay(5000);
    
    // Test 3: MinAmountOut Protection
    console.log('🛡️ Test 3: MinAmountOut Protection');
    
    const protectedTradeData = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: TEST_AMOUNTS.MEDIUM,
      minAmountOut: '1600000000' // Expecting at least 16 tokens out (for 20 in)
    };
    
    console.log('Submitting protected trade...');
    const result3 = await sendCustomJson(
      client,
      sscId,
      'hybrid_trade',
      protectedTradeData,
      username,
      privateKey
    );
    
    console.log('✅ Protected trade submitted:', result3.id);
    
    console.log('');
    console.log('🎉 All trades submitted successfully!');
    console.log('⏰ Wait a few minutes for processing');
    console.log('🔍 Check your account balance and trade history');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Export for use in other scripts
module.exports = { testMarketTrade };

// Run if called directly
if (require.main === module) {
  testMarketTrade().catch(console.error);
}
