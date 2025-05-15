// test-witness.js - Script to test witness registration directly

import mongoose from 'mongoose';

async function main() {
  try {
    console.log('Connecting to MongoDB...');
    // Database name from the output of 'show dbs'
    const mongoUri = 'mongodb://localhost:27017/echelon';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB:', mongoUri);
    
    // List collections to verify structure
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));
    
    const testAccount = 'echelon-node2';
    const publicKey = 'testPublicKey123456789012345678901234567890123456789012345';
    
    // Access the database directly using the MongoDB driver
    const db = mongoose.connection.db;
    
    // Check if we have the accounts collection
    if (collections.some(c => c.name === 'accounts')) {
      const accountsCollection = db.collection('accounts');
      
      console.log(`Fetching account ${testAccount} before update...`);
      const beforeAccount = await accountsCollection.findOne({ _id: testAccount });
      console.log('Before update:', beforeAccount);
      
      if (beforeAccount) {
        console.log(`Directly updating account ${testAccount} with public key ${publicKey}...`);
        const updateResult = await accountsCollection.updateOne(
          { _id: testAccount },
          { $set: { witnessPublicKey: publicKey } }
        );
        console.log('Update result:', updateResult);
        
        console.log(`Fetching account ${testAccount} after update...`);
        const afterAccount = await accountsCollection.findOne({ _id: testAccount });
        console.log('After update:', afterAccount);
      } else {
        console.log(`Account ${testAccount} not found. Creating it...`);
        const insertResult = await accountsCollection.insertOne({
          _id: testAccount,
          tokens: { ECH: 0 },
          nfts: {},
          witnessVotes: 0,
          votedWitnesses: [],
          witnessPublicKey: publicKey,
          createdAt: new Date()
        });
        console.log('Insert result:', insertResult);
        
        const newAccount = await accountsCollection.findOne({ _id: testAccount });
        console.log('Newly created account:', newAccount);
      }
    } else {
      console.log('No accounts collection found in the database!');
      
      // List all documents in database as a last resort
      for (const collection of collections) {
        console.log(`Checking collection ${collection.name}:`);
        const docs = await db.collection(collection.name).find({}).limit(2).toArray();
        console.log(`  Sample documents:`, docs);
      }
    }
    
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the script
main(); 