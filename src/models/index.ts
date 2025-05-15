import mongoose from 'mongoose';
import logger from '../logger.js';
import { BlockModel } from './block.js';
import config from '../config.js';
import { Account } from './account.js';
import { chain } from '../chain.js';

export async function initDB() {
  const uri = config.mongoUri;
  if (!uri) throw new Error('MONGO_URI not set in environment');
  try {
    await mongoose.connect(uri);
    logger.info('MongoDB connected');
    // Check and insert genesis block if needed
    const existing = await BlockModel.findById(0);
    if (!existing) {
      const genesisData = new BlockModel({
        _id: 0, // _id: 0
        blockNum: 0, // blockNum: 0
        steemBlockNum: config.steemStartBlock, // steemBlockNum: config.steemStartBlock
        phash: '0', // phash: '0'
        timestamp: 0, // timestamp: 0
        steemBlockTimestamp: 0, // steemBlockTimestamp: 0
        sync: false, // sync: false
        txs: [], // txs: []
        witness: config.masterName, // witness: config.masterName
        hash: '', // hash: '' (will be set below)
        signature: config.originHash, // signature: config.originHash
        missedBy: '', // missedBy: ''
        dist: config.witnessReward > 0 ? config.witnessReward : 0, // dist: config.witnessReward > 0 ? config.witnessReward : 0
      });
    // Calculate and set the actual hash for the genesis block
    genesisData.hash = chain.calculateBlockHash(
        genesisData._id,
        genesisData.phash,
        genesisData.timestamp,
        genesisData.txs,
        genesisData.witness,
        genesisData.missedBy,
        genesisData.dist
    );
      
      const genesisBlock = new BlockModel(genesisData);
      await genesisBlock.save();
      logger.info('Genesis block created.');
      // Ensure master account exists
      const masterAccount = await Account.findById(config.masterName);
      if (!masterAccount) {
        await Account.create({
          _id: config.masterName,
          createdAt: new Date(),
          tokens: { ECH: 1000000 },
          nfts: {},
          witnessVotes: 1000000,
          votedWitnesses: [config.masterName],
          witnessPublicKey: config.masterPublicKey
        });
        logger.info(`Master account '${config.masterName}' created with 1,000,000 ECH.`);
      } else {
        logger.info(`Master account '${config.masterName}' already exists.`);
      }
    } else {
      logger.info('Genesis block already exists.');
    }
  } catch (err) {
    logger.error('MongoDB connection error: ' + err);
    process.exit(1);
  }
} 