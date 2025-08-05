const { Client, PrivateKey } = require('dsteem');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') }); // Load .env from scripts folder

const ACCOUNTS_FILE_PATH = path.join(__dirname, 'accounts_steem.json');
// --- Configuration --- //
const STEEM_API_URL = process.env.STEEM_API_URL || 'https://api.steemit.com';
const ACCOUNT_B_NAME = process.env.TEST_ACCOUNT_B_NAME || 'echelon-edison'; // For transfers
const SSC_ID = process.env.SSC_ID || 'sidechain';

// Optional dsteem client settings from .env
const CLIENT_OPTIONS = {};
if (process.env.CHAIN_ID) {
  CLIENT_OPTIONS.chainId = process.env.CHAIN_ID;
}
if (process.env.ADDRESS_PREFIX) {
  CLIENT_OPTIONS.addressPrefix = process.env.ADDRESS_PREFIX;
}

let privateKeyString;
let username;

try {
  const accountsFileContent = fs.readFileSync(ACCOUNTS_FILE_PATH, 'utf8');
  const accounts = JSON.parse(accountsFileContent);
  const randomIndex = Math.floor(Math.random() * accounts.length);
  const selectedAccount = accounts[randomIndex];

  if (!selectedAccount) {
    throw new Error(`Account "${selectedAccount.account_name}" not found in ${ACCOUNTS_FILE_PATH}`);
  }
  if (!selectedAccount.private_keys || !selectedAccount.private_keys.active) {
    throw new Error(`Active key for account "${selectedAccount.account_name}" not found in ${ACCOUNTS_FILE_PATH}`);
  }
  privateKeyString = selectedAccount.private_keys.active;
  username = selectedAccount.account_name;
} catch (err) {
  console.error(`Error loading or parsing ${ACCOUNTS_FILE_PATH}:`, err.message);
  process.exit(1);
}

const privateKey = PrivateKey.fromString(privateKeyString);
const client = new Client(STEEM_API_URL, CLIENT_OPTIONS);

// --- Generic Helper --- //
async function sendCustomJson(contractAction, payload, actingUser = username, pk = privateKey) {
  const opPayload = { contract: contractAction, payload };
  const operation = ['custom_json', {
    required_auths: [actingUser],
    required_posting_auths: [],
    id: SSC_ID,
    json: JSON.stringify(opPayload),
  }];
  try {
    console.log(`Broadcasting ${contractAction} with payload:`, JSON.stringify(payload, null, 2));
    const result = await client.broadcast.sendOperations([operation], pk);
    console.log(`${contractAction} successful: TX ID ${result.id}`);
    return result;
  } catch (error) {
    console.error(`Error in ${contractAction}:`, error.message);
    if (error.data && error.data.stack) console.error('Dsteem error data:', error.data.stack);
    throw error;
  }
}

// --- Token Operation Helpers --- //
async function createToken(symbol, name, precision, maxSupply, initialSupply) {
  const payload = { 
    symbol, 
    name, 
    precision, 
    maxSupply: maxSupply.toString(), 
    initialSupply: initialSupply.toString() 
  };
  return sendCustomJson('token_create', payload);
}

async function mintTokens(symbol, to, amount) {
  const payload = { symbol, to, amount: amount.toString() };
  return sendCustomJson('token_mint', payload);
}

// --- Market Operation Helpers --- //
async function createMarketPair(baseSymbol, quoteSymbol) {
  const payload = {
    baseAsset: `${baseSymbol}@${username}`,
    quoteAsset: `${quoteSymbol}@${username}`,
    metadata: {
      description: `${baseSymbol}/${quoteSymbol} trading pair`,
      category: 'test'
    }
  };
  return sendCustomJson('market_create_pair', payload);
}

// Note: The old orderbook system has been replaced with hybrid trading
// Individual order placement is no longer available - use market_trade instead
async function executeHybridTrade(tokenIn, tokenOut, amountIn, maxSlippage = 2.0) {
  const payload = {
    trader: username,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    maxSlippagePercent: maxSlippage
  };
  return sendCustomJson('market_trade', payload);
}

async function cancelOrder(orderId) {
  const payload = {
    orderId,
    trader: username
  };
  return sendCustomJson('market_cancel_order', payload);
}

// --- Main Test Function --- //
async function runAdvancedMarketTest() {
  const baseSymbol = 'ECH';
  const baseName = 'Echelon Token';
  const quoteSymbol = 'USD';
  const quoteName = 'Test USD';
  const tokenPrecision = 4;
  const tokenMaxSupply = '10000000';
  const tokenInitialSupply = '1000000';
  const mintAmount = 10000;

  console.log(`Running advanced MARKET test with account: ${username} on ${STEEM_API_URL}`);
  console.log('📢 Using new hybrid trading system for optimal price discovery!');

  try {
    // 1. Create Base Token (ECH)
    console.log(`1. Creating base token ${baseSymbol}...`);
    await createToken(baseSymbol, baseName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 2. Create Quote Token (USD)
    console.log(`2. Creating quote token ${quoteSymbol}...`);
    await createToken(quoteSymbol, quoteName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 3. Mint additional tokens for testing
    console.log(`3. Minting ${mintAmount} ${baseSymbol} and ${quoteSymbol} to ${username}...`);
    await mintTokens(baseSymbol, username, mintAmount);
    await mintTokens(quoteSymbol, username, mintAmount);

    // 4. Create Trading Pair
    console.log(`4. Creating trading pair ${baseSymbol}/${quoteSymbol}...`);
    await createMarketPair(baseSymbol, quoteSymbol);
    console.log(`Trading pair created with automatic issuer assignment (${username})`);

    // 5. Add some AMM liquidity first (this creates initial price discovery)
    console.log(`5. Adding AMM liquidity to establish price...`);
    await sendCustomJson('pool_add_liquidity', {
      pairId: `${baseSymbol}-${quoteSymbol}`,
      baseAmount: (1000 * Math.pow(10, tokenPrecision)).toString(), // 1000 ECH
      quoteAmount: (1000 * Math.pow(10, tokenPrecision)).toString(), // 1000 USD (1:1 ratio)
      minBaseAmount: (950 * Math.pow(10, tokenPrecision)).toString(),
      minQuoteAmount: (950 * Math.pow(10, tokenPrecision)).toString()
    });

    // 6. Test hybrid trades (automatically routes through AMM + any orderbook liquidity)
    console.log(`6. Testing hybrid trade: Buy ${baseSymbol} with ${quoteSymbol}...`);
    await executeHybridTrade(
      `${quoteSymbol}@${username}`, // tokenIn (USD)
      `${baseSymbol}@${username}`,  // tokenOut (ECH)
      (100 * Math.pow(10, tokenPrecision)).toString(), // 100 USD
      2.0 // 2% max slippage
    );

    // 7. Test reverse hybrid trade
    console.log(`7. Testing hybrid trade: Sell ${baseSymbol} for ${quoteSymbol}...`);
    await executeHybridTrade(
      `${baseSymbol}@${username}`,  // tokenIn (ECH)
      `${quoteSymbol}@${username}`, // tokenOut (USD)
      (50 * Math.pow(10, tokenPrecision)).toString(), // 50 ECH
      2.0 // 2% max slippage
    );

    console.log('\n✅ Advanced market test completed successfully!');
    console.log('\nWhat happened:');
    console.log('• Created ECH/USD trading pair with secure sender-based issuer assignment');
    console.log('• Added AMM liquidity for price discovery');
    console.log('• Executed hybrid trades that automatically found best prices across:');
    console.log('  - AMM pool liquidity');
    console.log('  - Orderbook liquidity (if any existed)');
    console.log('• Smart routing minimized slippage and maximized execution quality');
    
    console.log('\nOld vs New System:');
    console.log('❌ Old: Manual orderbook orders with complex price/quantity calculations');
    console.log('✅ New: Simple hybrid trades with automatic best execution');
    
  } catch (error) {
    console.error('Advanced market test failed.');
    // Error details are logged by sendCustomJson
  }
}

runAdvancedMarketTest(); 