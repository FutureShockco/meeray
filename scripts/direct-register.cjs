// Direct database update script for witness registration

import { MongoClient } from 'mongodb';

async function main() {
  const url = 'mongodb://localhost:27017';
  const dbName = 'echelon'; 
  const client = new MongoClient(url);

  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(dbName);
    const accounts = db.collection('accounts');
    
    const accountName = 'echelon-node2';
    const publicKey = 'mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6';
    
    // Find account before update
    const beforeAccount = await accounts.findOne({ _id: accountName });
    console.log('Account before update:', beforeAccount);
    
    // Directly update the account's witnessPublicKey
    const updateResult = await accounts.updateOne(
      { _id: accountName },
      { $set: { witnessPublicKey: publicKey } }
    );
    
    console.log('Update result:', updateResult);
    
    // Verify update
    const afterAccount = await accounts.findOne({ _id: accountName });
    console.log('Account after update:', afterAccount);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
    console.log('Disconnected from MongoDB');
  }
}

main(); 