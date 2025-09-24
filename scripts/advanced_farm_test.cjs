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

// --- Farm Operation Helpers --- //
async function createFarm(lpTokenSymbol, rewardTokenSymbol) {
  const payload = {
    farmType: "TOKEN", // Or "LP_TOKEN" depending on the farm's design
    stakingTokenSymbol: lpTokenSymbol, // Renamed for clarity, was lpTokenSymbol
    stakingTokenIssuer: username,    // Renamed for clarity, was lpTokenIssuer
    rewardTokenSymbol,
    rewardTokenIssuer: username,
    rewardPerBlock: "100000", // Example: 1 token (assuming 5 decimals for reward token)
    rewardInterval: 86400,   // Example: 1 day in seconds
    multiplier: 1,           // Example: 1x multiplier
    maxStakingAmount: "100000000000" // Example: 1,000,000 tokens (assuming 5 decimals)
  };
  return sendCustomJson('farm_create', payload);
}

async function stakeFarm(farmId, lpTokenAmount) {
  const payload = {
    farmId,
    staker: username,
    lpTokenAmount: lpTokenAmount.toString()
  };
  return sendCustomJson('farm_stake', payload);
}

async function claimFarmRewards(farmId) {
  const payload = {
    farmId,
    staker: username
  };
  return sendCustomJson('farm_claim_rewards', payload);
}

async function unstakeFarm(farmId, lpTokenAmount) {
  const payload = {
    farmId,
    staker: username,
    lpTokenAmount: lpTokenAmount.toString()
  };
  return sendCustomJson('farm_unstake', payload);
}

// --- Main Test Function --- //
async function runAdvancedFarmTest() {
  const lpTokenSymbol = 'LPFARM';
  const lpTokenName = 'Farm LP Token';
  const rewardTokenSymbol = 'RWDFARM';
  const rewardTokenName = 'Farm Reward Token';
  const tokenPrecision = 4;
  const tokenMaxSupply = '10000000';
  const tokenInitialSupply = '1000000';
  const mintAmount = 10000;
  const stakeAmount = 1000;
  const unstakeAmount = 500;

  // Construct farmId (similar to poolId pattern)
  const expectedFarmId = `${lpTokenSymbol}:${rewardTokenSymbol}`;

  console.log(`Running advanced FARM test with account: ${username} on ${STEEM_API_URL}`);

  try {
    // 1. Create LP Token
    console.log(`1. Creating LP token ${lpTokenSymbol}...`);
    await createToken(lpTokenSymbol, lpTokenName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 2. Create Reward Token
    console.log(`2. Creating reward token ${rewardTokenSymbol}...`);
    await createToken(rewardTokenSymbol, rewardTokenName, tokenPrecision, tokenMaxSupply, tokenInitialSupply);

    // 3. Mint additional LP tokens to self for staking
    console.log(`3. Minting ${mintAmount} ${lpTokenSymbol} to ${username}...`);
    await mintTokens(lpTokenSymbol, username, mintAmount);

    // 4. Create Farm
    console.log(`4. Creating farm with LP token ${lpTokenSymbol} and reward token ${rewardTokenSymbol}...`);
    await createFarm(lpTokenSymbol, rewardTokenSymbol);
    console.log(`Farm creation initiated. Assumed Farm ID: ${expectedFarmId}`);

    // 5. Stake LP Tokens
    console.log(`5. Staking ${stakeAmount} ${lpTokenSymbol} to farm ${expectedFarmId}...`);
    await stakeFarm(expectedFarmId, stakeAmount);

    // 6. Wait a bit (simulating time passing for rewards)
    console.log('Waiting 5 seconds to simulate farming period...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Claim Rewards
    console.log(`7. Claiming rewards from farm ${expectedFarmId}...`);
    await claimFarmRewards(expectedFarmId);

    // 8. Unstake some LP Tokens
    console.log(`8. Unstaking ${unstakeAmount} ${lpTokenSymbol} from farm ${expectedFarmId}...`);
    await unstakeFarm(expectedFarmId, unstakeAmount);

    console.log('Advanced farm test completed successfully!');
  } catch (error) {
    console.error('Advanced farm test failed.');
    // Error details are logged by sendCustomJson
  }
}

runAdvancedFarmTest(); 