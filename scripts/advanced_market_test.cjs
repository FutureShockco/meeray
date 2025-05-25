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
    baseAssetSymbol: baseSymbol,
    baseAssetIssuer: username,
    quoteAssetSymbol: quoteSymbol,
    quoteAssetIssuer: username,
    tickSize: "10000",       // Represents 0.0001, assuming 8 decimal precision for price
    lotSize: "100000000",    // Represents 1, assuming 8 decimal precision for quantity
    minNotional: "100000000", // Represents 1, assuming 8 decimal precision for value
    initialStatus: "TRADING"
  };
  return sendCustomJson('market_create_pair', payload);
}

async function placeOrder(pairId, type, side, price, quantity) {
  const payload = {
    userId: username,
    pairId,
    type,
    side,
    // Assuming price and quantity are passed as numbers and need conversion based on contract precision
    // Example: if contract expects price with 8 decimals, 0.95 becomes "95000000"
    // Example: if contract expects quantity with 8 decimals, 100 becomes "10000000000"
    price: type === "LIMIT" ? (BigInt(Math.round(price * 100000000))).toString() : "0", // Convert to string BigInt, 0 for market
    quantity: (BigInt(Math.round(quantity * 100000000))).toString(), // Convert to string BigInt
    timeInForce: "GTC" // Good 'Til Canceled
  };
  return sendCustomJson('market_place_order', payload);
}

async function cancelOrder(pairId, orderId) {
  const payload = {
    userId: username,
    orderId,
    pairId
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

  // Construct pairId (pattern may need adjustment)
  const expectedPairId = `${baseSymbol}:${username}/${quoteSymbol}:${username}`;

  console.log(`Running advanced MARKET test with account: ${username} on ${STEEM_API_URL}`);

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
    console.log(`Trading pair created. Assumed Pair ID: ${expectedPairId}`);

    // 5. Place Limit Buy Order
    console.log(`5. Placing limit buy order: 100 ${baseSymbol} @ 0.95 ${quoteSymbol}...`);
    const buyResult = await placeOrder(expectedPairId, "LIMIT", "BUY", 0.95, 100);
    const buyOrderId = buyResult.id; // This might need adjustment based on how orderId is returned

    // 6. Place Limit Sell Order
    console.log(`6. Placing limit sell order: 50 ${baseSymbol} @ 1.05 ${quoteSymbol}...`);
    await placeOrder(expectedPairId, "LIMIT", "SELL", 1.05, 50);

    // 7. Cancel Buy Order
    console.log(`7. Canceling buy order ${buyOrderId}...`);
    await cancelOrder(expectedPairId, buyOrderId);

    // 8. Place Market Buy Order
    console.log(`8. Placing market buy order: 75 ${baseSymbol}...`);
    await placeOrder(expectedPairId, "MARKET", "BUY", 0, 75); // Price is ignored for market orders

    console.log('Advanced market test completed successfully!');
  } catch (error) {
    console.error('Advanced market test failed.');
    // Error details are logged by sendCustomJson
  }
}

runAdvancedMarketTest(); 