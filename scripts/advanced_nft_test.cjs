const { Client, PrivateKey } = require('dsteem');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const ACCOUNTS_FILE_PATH = path.join(__dirname, 'accounts_steem.json');

// --- Configuration --- //
const STEEM_API_URL = process.env.STEEM_API_URL || 'https://api.steemit.com';
const ACCOUNT_NAME = process.env.TEST_ACCOUNT_NAME || 'echelon-tesla';
const ACCOUNT_B_NAME = process.env.TEST_ACCOUNT_B_NAME || 'echelon-edison'; // For transfers/buy operations
const SSC_ID = process.env.SSC_ID || 'sidechain';

const CLIENT_OPTIONS = {};
if (process.env.CHAIN_ID) CLIENT_OPTIONS.chainId = process.env.CHAIN_ID;
if (process.env.ADDRESS_PREFIX) CLIENT_OPTIONS.addressPrefix = process.env.ADDRESS_PREFIX;

let primaryPrivateKeyString, primaryUsername;
let secondaryPrivateKeyString, secondaryUsername;

function loadAccount(accountName, filePath) {
  try {
    const accountsFileContent = fs.readFileSync(filePath, 'utf8');
    const accounts = JSON.parse(accountsFileContent);
    const selectedAccount = accounts.find(acc => acc.account_name === accountName);
    if (!selectedAccount) throw new Error(`Account "${accountName}" not found in ${filePath}`);
    if (!selectedAccount.private_keys || !selectedAccount.private_keys.active) {
      throw new Error(`Active key for "${accountName}" not found.`);
    }
    return { 
      privateKey: PrivateKey.fromString(selectedAccount.private_keys.active),
      username: selectedAccount.account_name 
    };
  } catch (err) {
    console.error(`Error loading account data for ${accountName}: ${err.message}`);
    throw err; // Re-throw to be caught by main try-catch
  }
}

try {
  // Use master account (echelon-node1) instead of accounts from file
  const keysFile = fs.readFileSync(path.join(__dirname, 'keys.json'));
  const privateKeys = JSON.parse(keysFile);

  primaryPrivateKey = PrivateKey.fromString(privateKeys[0]); // Use first key (echelon-node1)
  primaryUsername = 'echelon-node1'; // Master account name

  secondaryPrivateKey = PrivateKey.fromString(privateKeys[1]); // Use second key for secondary operations
  secondaryUsername = 'echelon-node2'; // Secondary account name

} catch (e) {
    process.exit(1);
}

const client = new Client(STEEM_API_URL, CLIENT_OPTIONS);

// --- Generic Helper --- //
async function sendCustomJson(contractAction, payload, actingUser, pk) {
  const opPayload = { contract: contractAction, payload };
  const operation = ['custom_json', {
    required_auths: [actingUser],
    required_posting_auths: [],
    id: SSC_ID,
    json: JSON.stringify(opPayload),
  }];
  try {
    console.log(`Broadcasting ${contractAction} by ${actingUser} with payload:`, JSON.stringify(payload, null, 2));
    const result = await client.broadcast.sendOperations([operation], pk);
    console.log(`${contractAction} successful: TX ID ${result.id}, Block: ${result.block_num}`);
    // Attempt to find logs/events for critical data like listingId
    if (result.id && (contractAction === 'nft_list_item' || contractAction.startsWith('market_'))) {
        try {
            await new Promise(resolve => setTimeout(resolve, 4000)); // Wait for block propagation
            const txInfo = await client.transaction.getTransaction(result.id);
            if (txInfo && txInfo.operations && txInfo.operations[0] && txInfo.operations[0][0] === 'custom_json') {
                const cjsonData = JSON.parse(txInfo.operations[0][1].json);
                if (cjsonData.logs) {
                    const logs = JSON.parse(cjsonData.logs);
                    if (logs.events && logs.events.length > 0) {
                         console.log('Transaction events:', JSON.stringify(logs.events, null, 2));
                         // Try to find listingId in events (example)
                         const listEvent = logs.events.find(e => e.event === 'listFixedPrice' || e.event === 'listOpenOrder');
                         if (listEvent && listEvent.data && listEvent.data.listingId) {
                             console.log('Found listingId:', listEvent.data.listingId);
                             result.listingId = listEvent.data.listingId; // Attach to result
                         }
                    }
                }
            }
        } catch (txError) {
            console.warn('Could not retrieve or parse transaction events for listingId:', txError.message);
        }
    }
    return result;
  } catch (error) {
    console.error(`Error in ${contractAction} by ${actingUser}:`, error.message);
    if (error.data && error.data.stack) console.error('Dsteem error data:', error.data.stack);
    throw error;
  }
}

// --- NFT Operation Helpers --- //
async function createCollection(symbol, name, schema, actingUser = primaryUsername, pk = primaryPrivateKey) {
  const payload = {
    symbol,
    name,
    creator: actingUser,
    maxSupply: "1000",
    mintable: true,
    burnable: true,
    transferable: true,
    creatorFee: 5, // 5%
    schema: JSON.stringify(schema),
    description: `A test collection for ${symbol}`,
    logoUrl: "https://example.com/logo.png",
    websiteUrl: "https://example.com/nft"
  };
  return sendCustomJson('nft_create_collection', payload, actingUser, pk);
}

async function mintNft(collectionSymbol, instanceId, owner, properties, uri, actingUser = primaryUsername, pk = primaryPrivateKey) {
  const payload = { collectionSymbol, instanceId, owner, properties, uri };
  return sendCustomJson('nft_mint', payload, actingUser, pk);
}

async function transferNft(collectionSymbol, instanceId, to, memo, actingUser, pk) {
  const payload = { collectionSymbol, instanceId, to, memo };
  return sendCustomJson('nft_transfer', payload, actingUser, pk);
}

async function listNft(collectionSymbol, instanceId, price, paymentToken, paymentTokenIssuer, actingUser, pk) {
  const payload = { collectionSymbol, instanceId, price: price.toString(), paymentTokenSymbol: paymentToken };
  // if (paymentTokenIssuer && paymentToken.toUpperCase() !== 'STEEM' && paymentToken.toUpperCase() !== 'SBD') {
  //   payload.paymentTokenIssuer = paymentTokenIssuer; 
  // }
  return sendCustomJson('nft_list_item', payload, actingUser, pk);
}

async function delistNft(listingId, actingUser, pk) {
  const payload = { listingId };
  return sendCustomJson('nft_delist_item', payload, actingUser, pk);
}

async function buyNft(listingId, actingUser, pk) {
  const payload = { listingId };
  return sendCustomJson('nft_buy_item', payload, actingUser, pk);
}

// --- Main Test Function --- //
async function runAdvancedNftTest() {
  const collectionSymbol = 'NFTADV';
  const collectionName = 'Advanced NFT Test Collection';
  const nftSchema = { type: "object", properties: { id: { type: "integer" }, color: { type: "string" } } };
  const nftInstanceId = `${collectionSymbol}-001`;
  const nftUri = `https://example.com/nft/${collectionSymbol}/001.json`;
  const nftProperties = { id: 1, color: "Blue" };
  
  const listingPrice = "10.000";
  const paymentToken = 'STEEM'; // Using native token for simplicity

  console.log(`Running advanced NFT test with primary account: ${primaryUsername}, secondary: ${secondaryUsername}`);

  try {
    // 1. Create Collection (Primary User)
    console.log(`1. ${primaryUsername} creating collection ${collectionSymbol}...`);
    await createCollection(collectionSymbol, collectionName, nftSchema, primaryUsername, primaryPrivateKey);

    // 2. Mint NFT (Primary User owns it)
    console.log(`2. ${primaryUsername} minting NFT ${nftInstanceId} to self...`);
    await mintNft(collectionSymbol, nftInstanceId, primaryUsername, nftProperties, nftUri, primaryUsername, primaryPrivateKey);

    // 3. Transfer NFT (Primary User to Secondary User)
    console.log(`3. ${primaryUsername} transferring NFT ${nftInstanceId} to ${secondaryUsername}...`);
    await transferNft(collectionSymbol, nftInstanceId, secondaryUsername, "Test transfer", primaryUsername, primaryPrivateKey);
    console.log(`NFT ${nftInstanceId} should now be owned by ${secondaryUsername}.`);

    // 4. List NFT for Sale (Secondary User lists it)
    console.log(`4. ${secondaryUsername} listing NFT ${nftInstanceId} for ${listingPrice} ${paymentToken}...`);
    const listResult = await listNft(collectionSymbol, nftInstanceId, listingPrice, paymentToken, primaryUsername, secondaryUsername, secondaryPrivateKey);
    
    let obtainedListingId = listResult.listingId; // Attempt to get from enhanced sendCustomJson
    if (!obtainedListingId) {
        console.warn('Could not obtain listingId from list_item transaction. Subsequent operations might fail or use placeholder.');
        // Fallback / Placeholder for testing - THIS IS NOT ROBUST
        obtainedListingId = `${collectionSymbol}-${nftInstanceId}-listing-placeholder`; 
    }
    console.log(`NFT ${nftInstanceId} listed by ${secondaryUsername}. Assumed/Retrieved Listing ID: ${obtainedListingId}`);

    // 5. Buy NFT (Primary User buys it back)
    console.log(`5. ${primaryUsername} buying NFT with listing ID ${obtainedListingId}...`);
    await buyNft(obtainedListingId, primaryUsername, primaryPrivateKey);
    console.log(`NFT ${nftInstanceId} should now be owned by ${primaryUsername} again.`);

    // --- Optional: List again and Delist ---
    // 6. List again by Primary User
    // console.log(`6. ${primaryUsername} listing NFT ${nftInstanceId} again...`);
    // const listResult2 = await listNft(collectionSymbol, nftInstanceId, "12.000", paymentToken, primaryUsername, primaryUsername, primaryPrivateKey);
    // let obtainedListingId2 = listResult2.listingId;
    // if (!obtainedListingId2) {
    //     console.warn('Could not obtain listingId_2 from list_item transaction.');
    //     obtainedListingId2 = `${collectionSymbol}-${nftInstanceId}-listing-placeholder2`;
    // }

    // // 7. Delist NFT (Primary User delists)
    // console.log(`7. ${primaryUsername} delisting NFT with listing ID ${obtainedListingId2}...`);
    // await delistNft(obtainedListingId2, primaryUsername, primaryPrivateKey);
    // console.log(`NFT listing ${obtainedListingId2} delisted by ${primaryUsername}.`);

    console.log('Advanced NFT test completed successfully!');
  } catch (error) {
    console.error('Advanced NFT test failed.');
  }
}

runAdvancedNftTest(); 