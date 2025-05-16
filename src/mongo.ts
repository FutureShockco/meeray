// TODO: Uncomment and install these dependencies as you migrate the rest of the Echelon codebase
// import config from './config.js';
// import logger from './logger.js';
// import ... (other dependencies)

// TODO: Add proper types for MongoDB logic, collections, etc.

import { MongoClient, Db, Collection, Admin } from 'mongodb';
import fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import sha256File from 'sha256-file';
import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
import { Block } from './block.js';

const DB_NAME = process.env.MONGO_DB || 'echelon';
const DB_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';

let dbInstance: Db | null = null;

export interface StateDoc {
    _id: number;
    headBlock?: number;
    // Add other state properties if any
}

export interface AccountDoc {
    name: string;
    witnessPublicKey?: string;
    tokens?: Record<string, number>;
    nfts?: Record<string, any>;
    totalVoteWeight?: number;
    votedWitnesses?: string[];
    created?: Date;
}

export const mongo = {
    db: null as Db | null, // To hold the db instance similar to this.db in JS example

    init: async (cb: (error: Error | null, state?: StateDoc | null) => void): Promise<void> => {
        try {
            const client = new MongoClient(DB_URL, {
                // useNewUrlParser: true, // Deprecated in newer MongoDB drivers
                // useUnifiedTopology: true // Deprecated
            });
            await client.connect();
            mongo.db = client.db(DB_NAME); // Set the db instance on the mongo object
            dbInstance = mongo.db; // also set module-scoped instance for easier access by older functions if needed


            logger.info(`Connected to ${DB_URL}/${mongo.db.databaseName}`);

            let state = await mongo.db.collection<StateDoc>('state').findOne({ _id: 0 });

            if (process.env.BLOCKS_DIR) {
                return cb(null, state);
            }

            if (process.env.REBUILD_STATE === '1' && (!state || !state.headBlock)) {
                logger.info('Rebuild specified and no existing state, dropping database and initializing genesis.');
                await mongo.db.dropDatabase();
                await mongo.initGenesis();
                // After initGenesis, re-fetch state as it might have been created.
                state = await mongo.db.collection<StateDoc>('state').findOne({ _id: 0 });
                return cb(null, state); 
            }

            const genesis = await mongo.db.collection<Block>('blocks').findOne({ _id: 0 });
            if (genesis) {
                if (genesis.hash !== config.originHash) {
                    logger.fatal('Block #0 hash doesn\'t match config. Did you forget to db.dropDatabase() ?');
                    process.exit(1);
                }
                cb(null, state);
            } else {
                await mongo.initGenesis();
                // After initGenesis, re-fetch state as it might have been created.
                state = await mongo.db.collection<StateDoc>('state').findOne({ _id: 0 });
                cb(null, state);
            }
        } catch (err: any) {
            logger.error('MongoDB init error:', err);
            // In case of error, cb should ideally be called with an error argument if its signature supported it.
            // For now, following the JS example's tendency to throw or exit, or cb with current state.
            // Consider a more robust error propagation via cb if possible.
            cb(err, null); // Call with null state on error to match one of the JS outcomes
        }
    },

    // Kept for other modules, but internal mongo functions can use mongo.db or dbInstance
    getDb: (): Db => {
        if (!dbInstance) {
            // Try to use mongo.db if dbInstance is null (e.g. getDb called before init fully completed setting dbInstance)
            if (mongo.db) {
                dbInstance = mongo.db;
                return dbInstance;
            }
            throw new Error('MongoDB has not been initialized. Call init() first.');
        }
        return dbInstance;
    },

    initGenesis: async (): Promise<void> => {
        const currentDb = mongo.getDb(); // Use getDb to ensure it's initialized
        if (process.env.REBUILD_STATE === '1') {
            logger.info('Starting genesis for rebuild...');
        } else {
            logger.info('Block #0 not found. Starting genesis...');
        }

        await mongo.addMongoIndexes();
        const genesisFolder = process.cwd() + '/genesis/';
        const genesisZip = genesisFolder + 'genesis.zip';
        const mongoUriForRestore = DB_URL; // URI for mongorestore, db name will be specified with -d

        try {
            fs.statSync(genesisZip);
            logger.info('Found genesis.zip file, checking sha256sum...');
            const fileHash = sha256File(genesisZip);
            logger.debug(config.originHash + '\t config.originHash');
            logger.debug(fileHash + '\t genesis.zip');

            if (fileHash !== config.originHash) {
                logger.fatal('Existing genesis.zip file does not match block #0 hash');
                process.exit(1);
            }

            logger.info('OK sha256sum, unzipping genesis.zip...');
            spawnSync('unzip', [genesisZip, '-d', genesisFolder]);
            logger.info('Finished unzipping, importing data now...');

            await mongo.restore(mongoUriForRestore, genesisFolder);
            logger.info('Finished importing genesis data');
            await mongo.insertBlockZero(); 

        } catch (err) {
            logger.warn('No genesis.zip file found or error during processing. Creating minimal genesis.');
            await mongo.insertMasterAccount();
            await mongo.insertBlockZero();
        }
    },

    restore: (mongoUri: string, folder: string): Promise<boolean> => {
        return new Promise((resolve) => {
            const mongorestore: ChildProcess = spawn('mongorestore', [
                `--uri=${mongoUri}`, // Use the base URI
                '-d', DB_NAME,      // Specify the database name separately
                folder
            ]);

            mongorestore.stderr?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const lineParts = lines[i].split('\t');
                    if (lineParts.length > 1 && lineParts[1].indexOf(DB_NAME + '.') > -1) {
                        logger.debug(lineParts[1]);
                    }
                }
            });
            mongorestore.on('close', (code) => {
                if (code !== 0) {
                    logger.error(`mongorestore process exited with code ${code}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
            mongorestore.on('error', (err) => {
                logger.error('Failed to start mongorestore:', err);
                resolve(false);
            });
        });
    },

    insertMasterAccount: async (): Promise<void> => {
        const currentDb = mongo.getDb();
        logger.info('Inserting new master account: ' + config.masterName);
        const masterAccount: AccountDoc = {
            name: config.masterName,
            created: new Date(), 
            tokens: { ECH: config.masterBalance },
            nfts: {},
            totalVoteWeight: config.masterBalance,
            votedWitnesses: [config.masterName],
            witnessPublicKey: process.env.WITNESS_PUBLIC_KEY
        };
        await currentDb.collection<AccountDoc>('accounts').insertOne(masterAccount);
    },

    insertBlockZero: async (): Promise<void> => {
        if (process.env.BLOCKS_DIR) return; 
        const currentDb = mongo.getDb();
        logger.info('Inserting Block #0 with hash ' + config.originHash);
        const genesisBlock = chain.getGenesisBlock(); 
        await currentDb.collection<Block>('blocks').insertOne(genesisBlock as any); // Cast to any if Block type is not directly compatible with MongoDB driver insert
    },

    addMongoIndexes: async (): Promise<void> => {
        const currentDb = mongo.getDb();
        try {
            await currentDb.collection('accounts').createIndex({ name: 1 });
            await currentDb.collection('accounts').createIndex({ totalVoteWeight: 1 });
            await currentDb.collection('tokens').createIndex({ symbol: 1 });
            logger.info('MongoDB indexes ensured.');
        } catch (indexError) {
            logger.error('Error creating MongoDB indexes:', indexError);
        }
    },

    fillInMemoryBlocks: async (cb: () => void, headBlock?: number): Promise<void> => {
        const currentDb = mongo.getDb();
        let query: any = {};
        if (headBlock) query._id = { $lt: headBlock };
        
        try {
            const blocksFromDb = await currentDb.collection<Block>('blocks').find(query, {
                sort: { _id: -1 },
                // Use (config as any) for properties that might not be in strict Config type
                limit: (config as any).ecoBlocksIncreasesSoon ? (config as any).ecoBlocksIncreasesSoon : (config as any).ecoBlocks || 1000
            }).toArray();
            
            chain.recentBlocks = blocksFromDb.reverse();
            logger.info(`Filled ${chain.recentBlocks.length} blocks into memory.`);
            // TODO: eco.loadHistory(); // If eco module is available and needed
            cb();
        } catch (err) {
            logger.error('Error in fillInMemoryBlocks:', err);
            cb(); 
        }
    },

    lastBlock: async (): Promise<Block | null> => {
        const currentDb = mongo.getDb();
        // The JS version uses a new Promise wrapper, but direct await is cleaner in TS
        return currentDb.collection<Block>('blocks').findOne({}, {
            sort: { _id: -1 }
        });
    },

    restoreBlocks: async (cb: (errMessage?: string | null) => void): Promise<void> => {
        const currentDb = mongo.getDb();
        const dump_dir = process.cwd() + '/dump';
        const dump_location = dump_dir + '/blocks.zip';
        const blocks_bson = dump_dir + '/blocks.bson';
        const blocks_meta = dump_dir + '/blocks.metadata.json';
        const mongoUriForRestore = DB_URL; // Base URI, DB name specified with -d

        if (process.env.UNZIP_BLOCKS === '1') {
            try {
                fs.statSync(dump_location);
            } catch (err) {
                return cb('blocks.zip file not found');
            }
        } else {
            try {
                fs.statSync(blocks_bson);
                fs.statSync(blocks_meta);
            } catch (e) {
                return cb('blocks mongo dump files not found');
            }
        }

        try {
            await currentDb.collection('blocks').drop();
            logger.info('Existing blocks collection dropped.');

            if (process.env.UNZIP_BLOCKS === '1') {
                spawnSync('unzip', [dump_location, '-d', dump_dir]);
                logger.info('Finished unzipping, importing blocks now...');
            } else {
                logger.info('Importing blocks for rebuild...');
            }

            const restoreSuccess = await mongo.restore(mongoUriForRestore, dump_dir);
            if (!restoreSuccess) {
                return cb('mongorestore command failed or encountered an error.');
            }

            const gBlock = await currentDb.collection<Block>('blocks').findOne({ _id: 0 });
            const lastRestored = await mongo.lastBlock(); // Changed from block to lastRestored to avoid conflict

            if (!gBlock) return cb('Genesis block not found in dump');
            if (gBlock.hash !== config.originHash) return cb('Genesis block hash in dump does not match config.originHash');

            logger.info(`Finished importing ${lastRestored?._id || 0} blocks`);
            if (lastRestored) {
                chain.restoredBlocks = lastRestored._id;
            }
            cb(null);
        } catch (err: any) {
            logger.error('Error during restoreBlocks:', err);
            cb(err.message || 'Unknown error during restoreBlocks');
        }
    }
};

export default mongo;