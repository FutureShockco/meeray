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

// --- Helper Functions for Token Operations (dsteem) --- //

async function sendCustomJson(contractAction, payload, actingUser = username, pk = privateKey) {
  const json = {
    contract: contractAction,
    payload,
  };

  const operation = [
    'custom_json',
    {
      required_auths: [actingUser],
      required_posting_auths: [],
      id: SSC_ID,
      json: JSON.stringify(json),
    },
  ];

  try {
    console.log(`Broadcasting ${contractAction} with payload:`, JSON.stringify(payload, null, 2));
    const result = await client.broadcast.sendOperations([operation], pk);
    console.log(`${contractAction} successful:`, JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error(`Error in ${contractAction}:`, error.message);
    if (error.data && error.data.stack) {
        console.error('dsteem error data:', JSON.stringify(error.data, null, 2));
    }
    throw error;
  }
}

async function createToken(symbol, name, precision, maxSupply, initialSupply) {
  const payload = {
    symbol,
    name,
    precision,
    maxSupply: maxSupply,
    initialSupply: initialSupply, // Add initialSupply as per typical token creation
    // Add other fields like mintable, burnable, description if needed, matching token_create.cjs
  };
  return sendCustomJson('token_create', payload);
}

async function mintTokens(symbol, to, amount) {
  const payload = {
    symbol,
    to,
    amount: amount,
  };
  return sendCustomJson('token_mint', payload);
}

async function transferTokens(symbol, to, amount, memo) {
  const payload = {
    symbol,
    to,
    amount: amount,
    memo,
  };
  return sendCustomJson('token_transfer', payload);
}

// --- Main Test Function --- //
async function runAdvancedTokenTest() {
  const tokenSymbol = 'ADVTS'; // Shorter symbol
  const tokenName = 'Advanced Test Token';
  const tokenPrecision = 4;
  const tokenMaxSupply = '1000000';
  const tokenInitialSupply = '100000'; // Initial supply to creator
  const mintQuantity = 1000;
  const transferToAccount = ACCOUNT_B_NAME;
  const transferQuantity = 50;
  const transferMemo = 'Advanced test transfer';

  console.log(`Running advanced token test with account: ${username} on ${STEEM_API_URL} using SSC_ID: ${SSC_ID}`);

  try {
    console.log(`Starting advanced token test for ${tokenSymbol}`);

    // 1. Create Token
    console.log(`Attempting to create token ${tokenSymbol}...`);
    await createToken(tokenSymbol, tokenName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);
    console.log(`Token ${tokenSymbol} created by ${username}. Initial supply: ${tokenInitialSupply}`);

    // 2. Mint Tokens (optional if initialSupply is sufficient, but good to test mint action)
    // Ensure the creator (username) can mint if the token is mintable (assuming it is by default for this test)
    console.log(`Attempting to mint ${mintQuantity} ${tokenSymbol} to ${username}...`);
    await mintTokens(tokenSymbol, username, mintQuantity);
    console.log(`Minted ${mintQuantity} ${tokenSymbol} to ${username}.`);

    // 3. Transfer Tokens
    console.log(`Attempting to transfer ${transferQuantity} ${tokenSymbol} from ${username} to ${transferToAccount}...`);
    await transferTokens(tokenSymbol, transferToAccount, transferQuantity, transferMemo);
    console.log(`Transferred ${transferQuantity} ${tokenSymbol} to ${transferToAccount}.`);

    console.log('Advanced token test completed successfully!');
  } catch (error) {
    console.error('Advanced token test failed.');
    // Error already logged in sendCustomJson or initial setup
  }
}

//runAdvancedTokenTest(); 