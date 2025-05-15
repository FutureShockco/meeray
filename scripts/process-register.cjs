// Script to directly process a witness register transaction

import mongoose from 'mongoose';
import { TransactionType } from '../src/steem/types.js';
import { processTransaction } from '../src/transactions/index.js';

async function main() {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect('mongodb://localhost:27017/echelon');
    console.log('Connected to MongoDB');
    
    const accountName = 'echelon-node2';
    const publicKey = 'mxRB23vGuuj4YjJNApTrjJ1D4urDoGJPt5Bqht26ZXm6';
    
    // Construct a transaction object
    const transaction = {
      id: 'manual-register-' + Date.now(),
      type: TransactionType.WITNESS_REGISTER,
      sender: accountName,
      data: {
        pub: publicKey
      },
      timestamp: Date.now()
    };
    
    console.log('Directly processing transaction:', JSON.stringify(transaction, null, 2));
    
    // Process the transaction
    const result = await processTransaction(transaction);
    
    console.log('Transaction processing result:', result);
    
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 