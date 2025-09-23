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

// Use master account (echelon-node1) instead of random account
let privateKeyString;
let username;

try {
  // Load private keys from keys.json (contains master account keys)
  const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
  const privateKeys = JSON.parse(keysFile);

  privateKeyString = privateKeys[0]; // Use first key (echelon-node1)
  username = 'echelon-node1'; // Master account name
} catch (err) {
  console.error('Error loading keys.json file:', err);
  process.exit(1);
}

const privateKey = PrivateKey.fromString(privateKeyString);
const client = new Client(STEEM_API_URL, CLIENT_OPTIONS);

// --- Generic Helper --- //
async function sendCustomJson(contractAction, payload, actingUser = username, pk = privateKey) {
  const opPayload = {
    contract: contractAction,
    payload,
  };
  const operation = [
    'custom_json',
    {
      required_auths: [actingUser],
      required_posting_auths: [],
      id: SSC_ID,
      json: JSON.stringify(opPayload),
    },
  ];
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

// --- Token Operation Helpers (Reused) --- //
async function createToken(symbol, name, precision, maxSupply, initialSupply) {
  const payload = { 
    symbol, 
    name, 
    precision, 
    maxSupply: maxSupply.toString(), // Ensure string
    initialSupply: initialSupply.toString() // Ensure string
  };
  return sendCustomJson('token_create', payload);
}

async function mintTokens(symbol, to, amount) {
  const payload = { 
    symbol, 
    to, 
    amount: amount.toString() // Ensure string
  };
  return sendCustomJson('token_mint', payload);
}

// --- Pool Operation Helpers --- //
async function createPool(tokenA_symbol, tokenB_symbol) {
  const payload = {
    tokenA_symbol,
    tokenB_symbol,
  };
  return sendCustomJson('pool_create', payload);
}

async function addLiquidity(poolId, tokenA_amount, tokenB_amount) {
  const payload = {
    poolId,
    user: username,
    tokenA_amount: tokenA_amount.toString(), // Ensure string
    tokenB_amount: tokenB_amount.toString(), // Ensure string
  };
  return sendCustomJson('pool_add_liquidity', payload);
}

async function swapTokens(poolId, tokenInSymbol, tokenOutSymbol, amountIn, minAmountOut) {
  const payload = {
    poolId,
    tokenInSymbol,
    tokenInIssuer: username,
    tokenOutSymbol,
    tokenOutIssuer: username,
    amountIn: amountIn.toString(), // Ensure string
    minAmountOut: minAmountOut.toString(), // Ensure string
  };
  return sendCustomJson('pool_swap', payload);
}

// --- Main Test Function --- //
async function runAdvancedPoolTest() {
  const tokenASymbol = 'POOLTA';
  const tokenAName = 'Pool Test Token A';
  const tokenBSymbol = 'POOLTB';
  const tokenBName = 'Pool Test Token B';
  const tokenPrecision = 4;
  const tokenMaxSupply = '10000000';
  const tokenInitialSupply = '500000';
  const mintAmount = 10000; // Amount of each token to mint for liquidity/swap

  const liquidityA = 1000;
  const liquidityB = 500;
  const swapAmountInA = 100;
  const minAmountOutB = 45; // Expected B for 100 A (example)

  console.log(`Running advanced POOL test with account: ${username} on ${STEEM_API_URL} (SSC_ID: ${SSC_ID})`);

  try {
    // 1. Create Token A
    console.log(`Creating token ${tokenASymbol}...`);
    await createToken(tokenASymbol, tokenAName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 2. Create Token B
    console.log(`Creating token ${tokenBSymbol}...`);
    await createToken(tokenBSymbol, tokenBName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 3. Mint Token A to self
    console.log(`Minting ${mintAmount} ${tokenASymbol} to ${username}...`);
    await mintTokens(tokenASymbol, username, mintAmount);

    // 4. Mint Token B to self
    console.log(`Minting ${mintAmount} ${tokenBSymbol} to ${username}...`);
    await mintTokens(tokenBSymbol, username, mintAmount);

    // 5. Create Pool
    // Assuming poolId will be tokenA_symbol:tokenB_symbol (this might need adjustment based on actual chain response)
    const expectedPoolId = `${tokenASymbol}:${tokenBSymbol}`;
    console.log(`Creating pool for ${tokenASymbol} and ${tokenBSymbol}...`);
    await createPool(tokenASymbol, tokenBSymbol);
    console.log(`Pool creation initiated for ${expectedPoolId}. Assuming successful creation for next steps.`);
    // Note: In a real scenario, you might query the chain to confirm poolId or get it from the creation TX result.

    // 6. Add Liquidity
    console.log(`Adding liquidity to pool ${expectedPoolId}: ${liquidityA} ${tokenASymbol} and ${liquidityB} ${tokenBSymbol}...`);
    await addLiquidity(expectedPoolId, liquidityA, liquidityB);

    // 7. Perform Swap (Token A for Token B)
    console.log(`Swapping ${swapAmountInA} ${tokenASymbol} for at least ${minAmountOutB} ${tokenBSymbol} in pool ${expectedPoolId}...`);
    await swapTokens(expectedPoolId, tokenASymbol, tokenBSymbol, swapAmountInA, minAmountOutB);

    console.log('Advanced pool test completed successfully!');
  } catch (error) {
    console.error('Advanced pool test failed.');
    // Error details are logged by sendCustomJson
  }
}

runAdvancedPoolTest(); 