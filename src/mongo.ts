import { MongoClient, Db } from 'mongodb';
import fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import sha256File from 'sha256-file';
import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
import { Block } from './block.js';
import { TokenData } from './transactions/token/token-interfaces.js';
import { toDbString, setTokenDecimals } from './utils/bigint.js';
import settings from './settings.js';

const DB_NAME = process.env.MONGO_DB || 'echelon';
const DB_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';

let dbInstance: Db | null = null;

export interface StateDoc {
    _id: number;
    headBlock?: number;
}

export interface AccountDoc {
    name: string;
    witnessPublicKey?: string;
    balances?: Record<string, string>; // Store as padded strings
    nfts?: Record<string, any>;
    totalVoteWeight?: string; // Store as padded string
    votedWitnesses?: string[];
    created?: Date;
}

export const mongo = {
    db: null as Db | null,

    init: async (cb: (error: Error | null, state?: StateDoc | null) => void): Promise<void> => {
        try {
            const client = new MongoClient(DB_URL, {});
            await client.connect();
            mongo.db = client.db(DB_NAME);
            dbInstance = mongo.db;

            logger.info(`Connected to ${DB_URL}/${mongo.db.databaseName}`);

            // Load all token decimals into the registry
            await mongo.loadAndRegisterAllTokenDecimals();

            let state = await mongo.db.collection<StateDoc>('state').findOne({ _id: 0 });

            if (process.env.BLOCKS_DIR) {
                return cb(null, state);
            }

            if (process.env.REBUILD_STATE === '1' && (!state || !state.headBlock)) {
                logger.info('Rebuild specified and no existing state, dropping database and initializing genesis.');
                await mongo.db.dropDatabase();
                await mongo.initGenesis();
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

            cb(err, null);
        }
    },
    getDb: (): Db => {
        if (!dbInstance) {
            if (mongo.db) {
                dbInstance = mongo.db;
                return dbInstance;
            }
            throw new Error('MongoDB has not been initialized. Call init() first.');
        }
        return dbInstance;
    },

    loadAndRegisterAllTokenDecimals: async (): Promise<void> => {
        if (!dbInstance) {
            logger.warn('[mongo] DB instance not available for loadAndRegisterAllTokenDecimals. Skipping.');
            return;
        }
        try {
            logger.info('[mongo] Loading and registering token decimals from database...');
            const tokensCollection = dbInstance.collection<TokenData>('tokens');
            const allTokens = await tokensCollection.find({}).toArray();

            if (allTokens.length === 0) {
                logger.info('[mongo] No tokens found in the database to register decimals for.');
                return;
            }

            for (const tokenDoc of allTokens) {
                if (tokenDoc.symbol && typeof tokenDoc.precision === 'number') {
                    setTokenDecimals(tokenDoc.symbol, tokenDoc.precision);
                    logger.trace(`[mongo] Registered decimals for ${tokenDoc.symbol}: ${tokenDoc.precision}`);
                } else {
                    logger.warn(`[mongo] Token document ${tokenDoc._id} is missing symbol or precision, or precision is not a number. Skipping registration.`);
                }
            }
            logger.info(`[mongo] Finished registering decimals for ${allTokens.length} token(s).`);
        } catch (error: any) {
            logger.error(`[mongo] Error loading token decimals: ${error?.message || error}`);
        }
    },

    initGenesis: async (): Promise<void> => {
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
            await mongo.insertMasterAndNullAccount();
            await mongo.insertBlockZero();
            await mongo.insertNativeTokens();
        }
    },

    restore: (mongoUri: string, folder: string): Promise<boolean> => {
        return new Promise((resolve) => {
            const mongorestore: ChildProcess = spawn('mongorestore', [
                `--uri=${mongoUri}`,
                '-d', DB_NAME,
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

    insertMasterAndNullAccount: async (): Promise<void> => {
        const currentDb = mongo.getDb();
        logger.info('Inserting new master account: ' + config.masterName);
        const masterAccount: AccountDoc = {
            name: config.masterName,
            created: new Date(),
            balances: { [config.nativeTokenSymbol]: toDbString(BigInt(config.masterBalance)) },
            nfts: {},
            totalVoteWeight: toDbString(BigInt(config.masterBalance)),
            votedWitnesses: [config.masterName],
            witnessPublicKey: config.masterPublicKey
        };
        const nullAccount: AccountDoc = {
            name: config.burnAccountName,
            created: new Date(),
            balances: { [config.nativeTokenSymbol]: toDbString(BigInt(0)) },
            nfts: {},
            totalVoteWeight: toDbString(BigInt(0)),
            votedWitnesses: [],
            witnessPublicKey: ''
        };
        await currentDb.collection<AccountDoc>('accounts').insertOne(masterAccount);
        await currentDb.collection<AccountDoc>('accounts').insertOne(nullAccount);
    },

    insertBlockZero: async (): Promise<void> => {
        if (process.env.BLOCKS_DIR) return;
        const currentDb = mongo.getDb();
        logger.info('Inserting Block #0 with hash ' + config.originHash);
        const genesisBlock = chain.getGenesisBlock();
        await currentDb.collection<Block>('blocks').insertOne(genesisBlock);
    },

    insertNativeTokens: async (): Promise<void> => {
        if (process.env.BLOCKS_DIR) return;
        const currentDb = mongo.getDb();

        setTokenDecimals(config.nativeTokenSymbol, 8);

        const MAX_SUPPLY_ECH_BIGINT = BigInt(config.masterBalance); // 200 million with 8 decimals
        const VERY_LARGE_MAX_SUPPLY_BIGINT = BigInt('1000000000000000000000000000000'); // Effectively unlimited for pegged tokens

        // This object represents the INPUT parameters for creating the native token ECH
        const nativeTokenCreationParams: TokenData = {
            symbol: config.nativeTokenSymbol,
            name: 'Echelon',
            precision: 8,
            maxSupply: toDbString(VERY_LARGE_MAX_SUPPLY_BIGINT),
            initialSupply: toDbString(MAX_SUPPLY_ECH_BIGINT),
            mintable: true,
            burnable: true,
            description: 'Echelon is the native token of the Echelon Network',
            logoUrl: '',
            websiteUrl: 'https://echelon.network'
        };

        const nativeTokenToStore: TokenData = {
            _id: nativeTokenCreationParams.symbol,
            symbol: nativeTokenCreationParams.symbol,
            name: nativeTokenCreationParams.name,
            precision: nativeTokenCreationParams.precision || 8,
            maxSupply: nativeTokenCreationParams.maxSupply,
            currentSupply: nativeTokenCreationParams.initialSupply || MAX_SUPPLY_ECH_BIGINT,
            mintable: nativeTokenCreationParams.mintable === undefined ? true : nativeTokenCreationParams.mintable,
            burnable: nativeTokenCreationParams.burnable === undefined ? true : nativeTokenCreationParams.burnable,
            issuer: config.masterName,
            description: nativeTokenCreationParams.description,
            logoUrl: nativeTokenCreationParams.logoUrl,
            websiteUrl: nativeTokenCreationParams.websiteUrl,
            createdAt: new Date().toISOString()
        };
        await currentDb.collection<TokenData>('tokens').insertOne(nativeTokenToStore);
        logger.info(`Native token ${config.nativeTokenSymbol} inserted.`);

        // --- STEEM ---
        setTokenDecimals('STEEM', 3);
        const nativeTokenCreationParamsSTEEM: TokenData = {
            symbol: 'STEEM',
            name: 'Steem',
            precision: 3,
            maxSupply: toDbString(VERY_LARGE_MAX_SUPPLY_BIGINT),
            initialSupply: toDbString(BigInt(0)),
            mintable: true,
            burnable: true,
            description: 'Steem is the native token of the Steem blockchain, pegged on this sidechain.',
            logoUrl: 'https://steem.com/images/steem-logo.png', // Placeholder URL
            websiteUrl: 'https://steem.com'
        };
        if (process.env.NODE_ENV === 'development') {
            nativeTokenCreationParamsSTEEM.symbol = 'TESTS';
            setTokenDecimals('TESTS', 3);
        }

        const nativeTokenToStoreSTEEM: TokenData = {
            _id: nativeTokenCreationParamsSTEEM.symbol,
            symbol: nativeTokenCreationParamsSTEEM.symbol,
            name: nativeTokenCreationParamsSTEEM.name,
            precision: nativeTokenCreationParamsSTEEM.precision || 3,
            maxSupply: nativeTokenCreationParamsSTEEM.maxSupply,
            currentSupply: nativeTokenCreationParamsSTEEM.initialSupply || BigInt(0),
            mintable: nativeTokenCreationParamsSTEEM.mintable === undefined ? true : nativeTokenCreationParamsSTEEM.mintable,
            burnable: nativeTokenCreationParamsSTEEM.burnable === undefined ? true : nativeTokenCreationParamsSTEEM.burnable,
            issuer: config.masterName,
            description: nativeTokenCreationParamsSTEEM.description,
            logoUrl: nativeTokenCreationParamsSTEEM.logoUrl,
            websiteUrl: nativeTokenCreationParamsSTEEM.websiteUrl,
            createdAt: new Date().toISOString()
        };
        await currentDb.collection<TokenData>('tokens').insertOne(nativeTokenToStoreSTEEM);
        logger.info('Native token STEEM inserted.');


        // --- SBD ---
        setTokenDecimals('SBD', 3);

        const nativeTokenCreationParamsSBD: TokenData = {
            symbol: 'SBD',
            name: 'Steem Dollar',
            precision: 3,
            maxSupply: toDbString(VERY_LARGE_MAX_SUPPLY_BIGINT),
            initialSupply: toDbString(BigInt(0)),
            mintable: true,
            burnable: true,
            description: 'SBD (Steem Dollar) is a stablecoin on the Steem blockchain, pegged on this sidechain.',
            logoUrl: 'https://steem.com/images/sbd-logo.png', // Placeholder URL
            websiteUrl: 'https://steem.com'
        };
        if (process.env.NODE_ENV === 'development') {
            nativeTokenCreationParamsSBD.symbol = 'TBD';
            setTokenDecimals('TBD', 3);
        }
        const nativeTokenToStoreSBD: TokenData = {
            _id: nativeTokenCreationParamsSBD.symbol,
            symbol: nativeTokenCreationParamsSBD.symbol,
            name: nativeTokenCreationParamsSBD.name,
            precision: nativeTokenCreationParamsSBD.precision || 3,
            maxSupply: nativeTokenCreationParamsSBD.maxSupply,
            currentSupply: nativeTokenCreationParamsSBD.initialSupply || BigInt(0),
            mintable: nativeTokenCreationParamsSBD.mintable === undefined ? true : nativeTokenCreationParamsSBD.mintable,
            burnable: nativeTokenCreationParamsSBD.burnable === undefined ? true : nativeTokenCreationParamsSBD.burnable,
            issuer: config.masterName,
            description: nativeTokenCreationParamsSBD.description,
            logoUrl: nativeTokenCreationParamsSBD.logoUrl,
            websiteUrl: nativeTokenCreationParamsSBD.websiteUrl,
            createdAt: new Date().toISOString()
        };
        await currentDb.collection<TokenData>('tokens').insertOne(nativeTokenToStoreSBD);
        logger.info('Native token SBD inserted.');


    },

    addMongoIndexes: async (): Promise<void> => {
        const currentDb = mongo.getDb();
        try {
            logger.debug('[DB Indexes] Creating indexes for accounts collection...');
            const accountsCollection = currentDb.collection('accounts');
            await accountsCollection.createIndex({ name: 1 });
            await accountsCollection.createIndex({ totalVoteWeight: 1 });
            logger.debug('[DB Indexes] Finished creating indexes for accounts collection.');

            logger.debug('[DB Indexes] Creating indexes for tokens collection...');
            const tokensCollection = currentDb.collection('tokens');
            await tokensCollection.createIndex({ symbol: 1 });
            await tokensCollection.createIndex({ launchpadId: 1 });
            await tokensCollection.createIndex({ owner: 1 });

            // NFT Collections
            logger.debug('[DB Indexes] Creating indexes for nftCollections collection...');
            const nftCollectionsCollection = currentDb.collection('nftCollections');
            await nftCollectionsCollection.createIndex({ _id: 1 }); // symbol is _id
            await nftCollectionsCollection.createIndex({ creator: 1 });
            logger.debug('[DB Indexes] Finished creating indexes for nftCollections collection.');

            // NFTs (Instances)
            logger.debug('[DB Indexes] Creating indexes for nfts collection...');
            const nftsCollection = currentDb.collection('nfts');
            await nftsCollection.createIndex({ _id: 1 }); // collectionSymbol-instanceId is _id
            await nftsCollection.createIndex({ collectionSymbol: 1 });
            await nftsCollection.createIndex({ owner: 1 });
            await nftsCollection.createIndex({ instanceId: 1 }); // If querying by instanceId across collections
            await nftsCollection.createIndex({ collectionSymbol: 1, instanceId: 1 }); // Compound for specific lookup
            logger.debug('[DB Indexes] Finished creating indexes for nfts collection.');

            // NFT Listings
            logger.debug('[DB Indexes] Creating indexes for nftListings collection...');
            const nftListingsCollection = currentDb.collection('nftListings');
            await nftListingsCollection.createIndex({ _id: 1 }); // listingId is _id
            await nftListingsCollection.createIndex({ collectionSymbol: 1, instanceId: 1 });
            await nftListingsCollection.createIndex({ seller: 1 });
            await nftListingsCollection.createIndex({ status: 1 });
            await nftListingsCollection.createIndex({ paymentTokenSymbol: 1 });
            await nftListingsCollection.createIndex({ collectionSymbol: 1, status: 1 }); // For finding active listings in a collection
            await nftListingsCollection.createIndex({ seller: 1, status: 1 }); // For finding active listings by a seller
            logger.debug('[DB Indexes] Finished creating indexes for nftListings collection.');

            // Events
            logger.debug('[DB Indexes] Creating indexes for events collection...');
            const eventsCollection = currentDb.collection('events');
            await eventsCollection.createIndex({ _id: 1 });
            await eventsCollection.createIndex({ type: 1 });
            await eventsCollection.createIndex({ actor: 1 });
            await eventsCollection.createIndex({ timestamp: 1 });
            await eventsCollection.createIndex({ "data.collectionSymbol": 1 }, { sparse: true });
            await eventsCollection.createIndex({ "data.instanceId": 1 }, { sparse: true });
            await eventsCollection.createIndex({ "data.listingId": 1 }, { sparse: true });
            logger.debug('[DB Indexes] Finished creating indexes for events collection.');

            // User Farm Positions
            logger.debug('[DB Indexes] Creating indexes for userFarmPositions collection...');
            const userFarmPositionsCollection = currentDb.collection('userFarmPositions');
            await userFarmPositionsCollection.createIndex({ _id: 1 }); // staker-farmId is _id
            await userFarmPositionsCollection.createIndex({ staker: 1 });
            await userFarmPositionsCollection.createIndex({ farmId: 1 });
            await userFarmPositionsCollection.createIndex({ staker: 1, farmId: 1 }); // Compound for specific lookup
            logger.debug('[DB Indexes] Finished creating indexes for userFarmPositions collection.');

            // User Liquidity Positions
            logger.debug('[DB Indexes] Creating indexes for userLiquidityPositions collection...');
            const userLiquidityPositionsCollection = currentDb.collection('userLiquidityPositions');
            await userLiquidityPositionsCollection.createIndex({ _id: 1 }); // provider-poolId is _id
            await userLiquidityPositionsCollection.createIndex({ provider: 1 });
            await userLiquidityPositionsCollection.createIndex({ poolId: 1 });
            await userLiquidityPositionsCollection.createIndex({ provider: 1, poolId: 1 }); // Compound for specific lookup
            logger.debug('[DB Indexes] Finished creating indexes for userLiquidityPositions collection.');

            // Trading Pairs (formerly markets)
            logger.debug('[DB Indexes] Creating indexes for tradingPairs collection...');
            const tradingPairsCollection = currentDb.collection('tradingPairs');
            await tradingPairsCollection.createIndex({ _id: 1 }); // pairId is _id
            await tradingPairsCollection.createIndex({ status: 1 });
            await tradingPairsCollection.createIndex({ baseAssetSymbol: 1, baseAssetIssuer: 1, quoteAssetSymbol: 1, quoteAssetIssuer: 1 }, { name: "assets_combination_idx" });
            logger.debug('[DB Indexes] Finished creating indexes for tradingPairs collection.');

            // Launchpads Collection Indexes
            logger.debug('[DB Indexes] Creating indexes for launchpads collection...');
            const launchpadsCollection = currentDb.collection('launchpads');
            await launchpadsCollection.createIndex({ status: 1 });
            await launchpadsCollection.createIndex({ launchedByUserId: 1 });
            await launchpadsCollection.createIndex({ "tokenToLaunch.symbol": 1 });
            await launchpadsCollection.createIndex({ mainTokenId: 1 });
            await launchpadsCollection.createIndex({ "presale.participants.userId": 1 });
            logger.debug('[DB Indexes] Finished creating indexes for launchpads collection.');

            // Orders
            logger.debug('[DB Indexes] Creating indexes for orders collection...');
            const ordersCollection = currentDb.collection('orders');
            await ordersCollection.createIndex({ _id: 1 });
            await ordersCollection.createIndex({ pairId: 1 });
            await ordersCollection.createIndex({ userId: 1 });
            await ordersCollection.createIndex({ status: 1 });
            await ordersCollection.createIndex({ pairId: 1, status: 1 }); // For finding open/filled orders in a pair
            await ordersCollection.createIndex({ userId: 1, status: 1 }); // For finding user's open/filled orders
            await ordersCollection.createIndex({ pairId: 1, side: 1, price: 1, status: 1 }); // For order book reconstruction / matching query
            logger.debug('[DB Indexes] Finished creating indexes for orders collection.');

            // Trades
            logger.debug('[DB Indexes] Creating indexes for trades collection...');
            const tradesCollection = currentDb.collection('trades');
            await tradesCollection.createIndex({ _id: 1 });
            await tradesCollection.createIndex({ pairId: 1 });
            await tradesCollection.createIndex({ timestamp: -1 });
            await tradesCollection.createIndex({ makerOrderId: 1 });
            await tradesCollection.createIndex({ takerOrderId: 1 });
            logger.debug('[DB Indexes] Finished creating indexes for trades collection.');

            // Pools (Liquidity Pools)
            logger.debug('[DB Indexes] Creating indexes for pools collection...');
            const poolsCollection = currentDb.collection('pools');
            await poolsCollection.createIndex({ _id: 1 }); // poolId
            await poolsCollection.createIndex({ tokenA_symbol: 1 });
            await poolsCollection.createIndex({ tokenB_symbol: 1 });
            await poolsCollection.createIndex({ creator: 1 });
            logger.debug('[DB Indexes] Finished creating indexes for pools collection.');

            logger.debug('MongoDB indexes ensured for all relevant collections.');
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
                limit: config.memoryBlocks || 1000
            }).toArray();

            chain.recentBlocks = blocksFromDb.reverse();
            logger.info(`Filled ${chain.recentBlocks.length} blocks into memory.`);
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
        const mongoUriForRestore = DB_URL;

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

            logger.debug(`Finished importing ${lastRestored?._id || 0} blocks`);
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