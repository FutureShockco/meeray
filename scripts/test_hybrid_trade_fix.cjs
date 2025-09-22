const axios = require('axios');

const API_BASE = 'http://localhost:3000';

async function testHybridTrade() {
  try {
    console.log('Testing hybrid trade with minAmountOut...');
    
    const tradeData = {
      tokenIn: 'MRY',
      tokenOut: 'TESTS',
      amountIn: '100000000000', // 100,000 MRY (8 decimals)
      minAmountOut: '100000' // 100,000 TESTS (3 decimals)
    };

    console.log('Trade data:', tradeData);
    
    const response = await axios.post(`${API_BASE}/market/hybrid/quote`, tradeData);
    console.log('Quote response:', JSON.stringify(response.data, null, 2));
    
    // Now try to execute the trade
    console.log('\nExecuting hybrid trade...');
    const executeResponse = await axios.post(`${API_BASE}/market/hybrid/trade`, {
      ...tradeData,
      sender: 'echelon-node1'
    });
    
    console.log('Execute response:', JSON.stringify(executeResponse.data, null, 2));
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testHybridTrade();
