// createWitness.js - Script to create a witness via Steem

import { Client, PrivateKey } from '@hiveio/dhive';

// Configuration
const nodeUrl = 'https://api.steemit.com';
const username = 'echelon-node2'; // The account to register as witness
const privateKey = 'your-private-key'; // The account's private active key
const witnessPublicKey = 'eShNsq4FFZGBJKHtiTV9T3TWEtYQCR6g6M5TTdR4SK5k'; // Public key for witness duties

async function main() {
  try {
    console.log(`Registering ${username} as a witness with public key ${witnessPublicKey}...`);
    
    // Initialize Steem client
    const client = new Client(nodeUrl);
    
    // Create the custom_json operation for witness registration
    const registerOperation = [
      'custom_json',
      {
        required_auths: [username],
        required_posting_auths: [],
        id: 'sidechain',
        json: JSON.stringify({
          contract: 'witness_register',
          payload: {
            pub: witnessPublicKey
          }
        })
      }
    ];
    
    console.log('Operation payload:', registerOperation);
    
    // Uncomment to actually broadcast the transaction
    /*
    // Send the operation with proper credentials
    const result = await client.broadcast.sendOperations(
      [registerOperation],
      PrivateKey.fromString(privateKey)
    );
    
    console.log('Transaction broadcast result:', result);
    */
    
    console.log('Witness registration operation created (not broadcast)');
    console.log('To broadcast, replace your private key and uncomment the broadcast section');
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the script
main(); 