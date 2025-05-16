const mongoose = require('mongoose');
const config = require('./dist/config.js').default;
const { Account } = require('./dist/db/account.js');

async function checkWitnesses() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('Connected to database');
    
    // Find all witness accounts
    const witnesses = await Account.find({ 
      totalVoteWeight: { $gt: 0 },
      witnessPublicKey: { $ne: null }
    });
    
    console.log(`Found ${witnesses.length} witness accounts:`);
    witnesses.forEach(w => {
      console.log(`- ${w._id}: votes=${w.totalVoteWeight}, key=${w.witnessPublicKey ? w.witnessPublicKey.substring(0, 8) + '...' : 'none'}`);
    });
    
    // Check specific account
    const account = await Account.findOne({ _id: 'echelon-node2' });
    if (account) {
      console.log(`\nechelon-node2: votes=${account.totalVoteWeight ?? 0}, key=${account.witnessPublicKey ? 'yes' : 'no'}`);
    } else {
      console.log('\nechelon-node2 account not found in database');
    }
    
    mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

checkWitnesses(); 