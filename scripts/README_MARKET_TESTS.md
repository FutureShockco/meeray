# MeeRay Market Trading Test Scripts

This directory contains comprehensive test scripts for the MeeRay hybrid trading system.

## Test Scripts

### 1. `advanced_hybrid_trade_test.cjs` - Comprehensive Test Suite

A professional-grade test suite that covers all aspects of the hybrid trading system:

**Features:**
- ✅ Liquidity source discovery
- ✅ Quote generation and validation  
- ✅ Market order execution (auto-routing)
- ✅ Limit order placement
- ✅ Slippage protection testing
- ✅ MinAmountOut validation
- ✅ Manual route specification
- ✅ Invalid input handling
- ✅ Market statistics APIs
- ✅ Detailed reporting and logging

**Usage:**
```bash
# 1. Ensure you have keys.json with your account credentials
#    ["your-private-posting-key-here"]

# 2. Make sure your MeeRay node is running locally
#    API should be accessible at http://localhost:3000

# 3. Run the comprehensive test suite
node scripts/advanced_hybrid_trade_test.cjs

# 4. Check the generated test report file
# Results are saved to: hybrid-trade-test-results-[timestamp].json
```

### 2. `market_test_simple.cjs` - Quick Basic Tests

A simplified test script for quick validation of core trading functionality:

**Features:**
- 📈 Market order with auto-routing
- 📊 Limit order placement
- 🛡️ MinAmountOut protection test

**Usage:**
```bash
# 1. Ensure keys.json file is configured (same as above)

# 2. Run the simple tests
node scripts/market_test_simple.cjs
```

## Configuration

The scripts now follow the same structure as other MeeRay scripts:

**Requirements:**
- **`keys.json`** file in the scripts directory with account credentials:
  ```json
  ["your-private-posting-key-here"]
  ```
- **MeeRay node** running locally (API available at http://localhost:3000)
- **Account with sufficient balances** for testing

**Configuration variables** (can be edited in each script):
```javascript
// Test tokens
const TOKEN_A = 'MRY';
const TOKEN_B = 'STEEM';

// Test amounts (8 decimal precision)
const TEST_AMOUNTS = {
  SMALL: '1000000000',  // 10 tokens
  MEDIUM: '5000000000', // 50 tokens  
  LARGE: '10000000000'  // 100 tokens
};
```

## Test Types Explained

### Market Orders
- **Auto-routing**: System automatically finds best execution path
- **Slippage protection**: Uses `maxSlippagePercent` to limit price impact
- **Immediate execution**: Trades execute immediately at market prices

### Limit Orders  
- **Price specification**: User sets exact price for execution
- **Order book placement**: Orders wait in book until price is met
- **No slippage risk**: Price is guaranteed if order fills

### Slippage Protection
- **maxSlippagePercent**: Percentage-based protection (recommended)
- **minAmountOut**: Exact minimum output amount (advanced)
- **Smart routing**: System may route to orderbook if AMM slippage too high

### Route Types
- **AMM Routes**: Execute through liquidity pools
- **Orderbook Routes**: Execute through order matching
- **Hybrid Routes**: Combine multiple sources for optimal execution

## Expected Results

### Successful Test Output
```
🚀 Starting MeeRay Hybrid Trading Test Suite
================================================
[INFO] Test 1/9: Liquidity Sources API - ✅ PASS
[INFO] Test 2/9: Hybrid Quote API - ✅ PASS
[INFO] Test 3/9: Market Order Execution - ✅ PASS
...
📊 TEST SUITE RESULTS
====================
✅ Passed: 8
❌ Failed: 1  
📈 Success Rate: 88.9%
```

### Common Issues and Solutions

**Issue**: "Trading pair not found"
**Solution**: Ensure trading pairs exist in the system. Create pairs first if needed.

**Issue**: "Insufficient balance"
**Solution**: Make sure test accounts have sufficient token balances.

**Issue**: "No liquidity available"
**Solution**: Add liquidity to pools or place orders in orderbooks.

**Issue**: "API connection failed"
**Solution**: Verify MeeRay node is running locally and API is accessible at http://localhost:3000.

**Issue**: "Error loading keys.json file"
**Solution**: Create a keys.json file in the scripts directory with your private posting key as a JSON array.

## Test Data Analysis

The comprehensive test suite generates detailed JSON reports including:

- Transaction IDs for each test
- Balance changes and confirmations
- API response data and timing
- Error details and debugging info
- Performance metrics and statistics

Use these reports to:
- Debug failed transactions
- Analyze system performance
- Validate trading logic
- Monitor slippage and routing efficiency

## Advanced Testing

For production systems, consider:

1. **Load Testing**: Run multiple concurrent trades
2. **Edge Case Testing**: Test with extreme amounts and prices
3. **Network Testing**: Test with network delays and failures
4. **Security Testing**: Test with malformed inputs and attacks
5. **Performance Testing**: Measure latency and throughput

## Support

If tests fail or you encounter issues:

1. Check the detailed error logs
2. Verify your configuration is correct
3. Ensure your node is fully synced
4. Check account balances and permissions
5. Review the generated test reports

For additional help, consult the main MeeRay documentation or contact support.
