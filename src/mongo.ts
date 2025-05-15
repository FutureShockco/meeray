// TODO: Uncomment and install these dependencies as you migrate the rest of the Echelon codebase
// import config from './config.js';
// import logger from './logger.js';
// import ... (other dependencies)

// TODO: Add proper types for MongoDB logic, collections, etc.

import mongoose from 'mongoose';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import sha256File from 'sha256-file';
import logger from './logger.js';
import { BlockModel, IBlock } from './models/block.js';
import { Account, IAccount } from './models/account.js';
import { initDB } from './models/index.js';
import config from './config.js';
import { StateModel, IState } from './models/state.js';
import { chain } from './chain.js';


const db_name = process.env.MONGO_DB || 'echelon';
const db_url = process.env.MONGO_URL || 'mongodb://localhost:27017';

export const mongo = {
    // Use Mongoose connection and models
    init: async (cb: (state: any) => void) => {
        await mongoose.connect(db_url + '/' + db_name);
        logger.info('Connected to ' + db_url + '/' + db_name);
        let state = await StateModel.findById(0);
        if (process.env.BLOCKS_DIR) return cb(state);
        if (process.env.REBUILD_STATE === '1' && (!state || !state.headBlock)) {
            await mongoose.connection.db.dropDatabase();
            await mongo.initGenesis();
            return cb(state);
        }
        const genesis = await BlockModel.findById(0);
        if (genesis) {
            if (genesis.hash !== config.originHash) {
                logger.fatal("Block #0 hash doesn't match config. Did you forget to db.dropDatabase() ?");
                process.exit(1);
            }
            cb(state);
        } else {
            await mongo.initGenesis();
            cb(state);
        }
    },
    initGenesis: async () => {
        if (process.env.REBUILD_STATE === '1')
            logger.info('Starting genesis for rebuild...');
        else
            logger.info('Block #0 not found. Starting genesis...');
        let genesisFolder = process.cwd() + '/genesis/';
        let genesisZip = genesisFolder + 'genesis.zip';
        let mongoUri = db_url + '/' + db_name;
        try {
            fs.statSync(genesisZip);
        } catch (err) {
            logger.warn('No genesis.zip file found');
            await mongo.insertMasterAccount();
            await mongo.insertBlockZero();
            return;
        }
        logger.info('Found genesis.zip file, checking sha256sum...');
        let fileHash = sha256File(genesisZip);
        logger.debug(config.originHash + '\t config.originHash');
        logger.debug(fileHash + '\t genesis.zip');
        if (fileHash !== config.originHash) {
            logger.fatal('Existing genesis.zip file does not match block #0 hash');
            process.exit(1);
        }
        logger.info('OK sha256sum, unzipping genesis.zip...');
        spawnSync('unzip', [genesisZip, '-d', genesisFolder]);
        logger.info('Finished unzipping, importing data now...');
        await mongo.restore(mongoUri, genesisFolder);
        logger.info('Finished importing genesis data');
        await mongo.insertBlockZero();
    },
    restore: (mongoUri: string, folder: string) => {
        return new Promise((rs) => {
            const mongorestore = spawn('mongorestore', ['--uri=' + mongoUri, '-d', db_name, folder]);
            mongorestore.stderr.on('data', (data) => {
                data = data.toString().split('\n');
                for (let i = 0; i < data.length; i++) {
                    let line = data[i].split('\t');
                    if (line.length > 1 && line[1].indexOf(db_name + '.') > -1)
                        logger.debug(line[1]);
                }
            });
            mongorestore.on('close', () => rs(true));
        });
    },
    insertMasterAccount: async () => {
        logger.info('Inserting new master account: ' + config.masterName);
        await Account.create({
            _id: config.masterName,
            name: config.masterName,
            witnessPublicKey: config.masterPublicKey,
            tokens: {"ECH": config.masterBalance},
            votedWitnesses: [config.masterName],
            witnessVotes: config.masterBalance,
            created: config.block0ts
        });
    },
    insertBlockZero: async () => {
        if (process.env.BLOCKS_DIR) return;
        logger.info('Inserting Block #0 with hash ' + config.originHash);
        await BlockModel.create(chain.getGenesisBlock());
    },
    fillInMemoryBlocks: async (cb: () => void, headBlock?: number) => {
        let query: any = {};
        if (headBlock) query._id = { $lt: headBlock };
        const limit = config.ecoBlocksIncreasesSoon ? config.ecoBlocksIncreasesSoon : config.ecoBlocks;
        const blocks = await BlockModel.find(query).sort({ _id: -1 }).limit(limit).exec();
        chain.recentBlocks = blocks.reverse();
        cb();
    },
    lastBlock: async (): Promise<IBlock | null> => {
        return BlockModel.findOne({}, {}, { sort: { _id: -1 } });
    },
    restoreBlocks: async (cb: (err: string | null) => void) => {
        let dump_dir = process.cwd() + '/dump';
        let dump_location = dump_dir + '/blocks.zip';
        let blocks_bson = dump_dir + '/blocks.bson';
        let blocks_meta = dump_dir + '/blocks.metadata.json';
        let mongoUri = db_url + '/' + db_name;
        if (process.env.UNZIP_BLOCKS === '1')
            try {
                fs.statSync(dump_location);
            } catch (err) {
                return cb('blocks.zip file not found');
            }
        else
            try {
                fs.statSync(blocks_bson);
                fs.statSync(blocks_meta);
            } catch (e) {
                return cb('blocks mongo dump files not found');
            }
        await BlockModel.collection.drop();
        if (process.env.UNZIP_BLOCKS === '1') {
            spawnSync('unzip', [dump_location, '-d', dump_dir]);
            logger.info('Finished unzipping, importing blocks now...');
        } else {
            logger.info('Importing blocks for rebuild...');
        }
        await mongo.restore(mongoUri, dump_dir);
        const gBlock = await BlockModel.findById(0);
        const block = await mongo.lastBlock();
        if (!gBlock) return cb('Genesis block not found in dump');
        if (gBlock.hash !== config.originHash) return cb('Genesis block hash in dump does not match config.originHash');
        logger.info('Finished importing ' + (block?._id ?? '?') + ' blocks');
        // Update chain.restoredBlocks if available
        // chain.restoredBlocks = block._id;
        cb(null);
    }
};

export default mongo;