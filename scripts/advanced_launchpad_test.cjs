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

// Helper for date strings
const getFutureDateString = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

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

// --- Launchpad Operation Helpers --- //
async function launchToken(tokenSymbol, tokenName, quoteAssetSymbol) {
  const tokenomicsData = {
    totalSupply: "100000000000000", // 100 Million with 6 decimals assumed for the launched token
    tokenDecimals: 6,
    allocations: [
      { recipient: "PROJECT_TEAM", percentage: 15, lockupMonths: 6, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 24, cliffMonths: 6 } },
      { recipient: "PRESALE_INVESTORS", percentage: 30 },
      { recipient: "LIQUIDITY_POOL", percentage: 25 },
      { recipient: "ECOSYSTEM_FUND", percentage: 20, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 36 } },
      { recipient: "ADVISORS", percentage: 10, lockupMonths: 3, vestingSchedule: { type: "LINEAR_MONTHLY", durationMonths: 12, cliffMonths: 3 } }
    ]
  };

  const presaleDetailsData = {
    presaleTokenAllocationPercentage: 30,
    pricePerToken: "50000", // Price in quote asset (e.g., 0.05 with 6 decimals for quote asset)
    quoteAssetForPresaleSymbol: quoteAssetSymbol,
    minContributionPerUser: "50000000", // e.g., 50 with 6 decimals for quote asset
    maxContributionPerUser: "5000000000", // e.g., 5000 with 6 decimals for quote asset
    startTime: getFutureDateString(1), // 1 day from now
    endTime: getFutureDateString(3),   // 3 days from now
    hardCap: "1000000000000", // e.g., 1,000,000 with 6 decimals for quote asset
    softCap: "250000000000",   // e.g., 250,000 with 6 decimals for quote asset
    whitelistRequired: false,
    fcfsAfterReservedAllocation: true
  };

  const payload = {
    userId: username,
    tokenName: tokenName,
    tokenSymbol: tokenSymbol,
    tokenDescription: `${tokenName} - A test token launched via the Echelon Launchpad.`,
    tokenLogoUrl: "https://example.com/token.png",
    projectWebsite: "https://example.com",
    projectSocials: { twitter: "@example", telegram: "t.me/example" },
    tokenomics: tokenomicsData,
    presaleDetails: presaleDetailsData
  };

  return sendCustomJson('launchpad_launch_token', payload);
}

async function claimTokens(launchpadId, allocationType = "PRESALE_INVESTORS") {
  const payload = {
    userId: username,
    launchpadId,
    allocationType
  };
  return sendCustomJson('launchpad_claim_tokens', payload);
}

// --- Main Test Function --- //
async function runAdvancedLaunchpadTest() {
  const quoteAssetSymbol = 'MRYGAME';
  const quoteAssetName = 'USD';
  const tokenSymbol = 'LPTEST';
  const tokenName = 'Launchpad Test Token';
  const tokenPrecision = 6;
  const tokenMaxSupply = '10000000';
  const tokenInitialSupply = '1000000';

  // Construct launchpadId (pattern may need adjustment)
  const expectedLaunchpadId = `${tokenSymbol}-LAUNCH-1`;

  console.log(`Running advanced LAUNCHPAD test with account: ${username} on ${STEEM_API_URL}`);

  try {
    // 1. Create Quote Asset Token (MRYUSD)
    console.log(`1. Creating quote asset token ${quoteAssetSymbol}...`);
    await createToken(quoteAssetSymbol, quoteAssetName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 2. Launch Token
    console.log(`2. Launching token ${tokenSymbol} with ${quoteAssetSymbol} as quote asset...`);
    await launchToken(tokenSymbol, tokenName, quoteAssetSymbol);
    console.log(`Token launch initiated. Assumed Launchpad ID: ${expectedLaunchpadId}`);

    // Note: In a real scenario, we would:
    // 1. Wait for presale to start
    // 2. Contribute to presale (if contract available)
    // 3. Wait for presale to end
    // Here we'll simulate waiting and try to claim

    // Simulate waiting for presale end
    console.log('Waiting 5 seconds to simulate presale period...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 3. Claim Tokens
    console.log(`3. Claiming tokens from launchpad ${expectedLaunchpadId}...`);
    await claimTokens(expectedLaunchpadId);

    console.log('Advanced launchpad test completed successfully!');
  } catch (error) {
    console.error('Advanced launchpad test failed.');
    // Error details are logged by sendCustomJson
  }
}

runAdvancedLaunchpadTest(); 