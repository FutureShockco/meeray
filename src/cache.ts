import parallel from 'run-parallel';
import cloneDeep from 'clone-deep';
import ProcessingQueue from './processingQueue.js';
import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';

import txHistory from './modules/txHistory.js';
import witnessesStats from './modules/witnessesStats.js';

import { Db, Filter, Document as MongoDocument, UpdateFilter, FindOptions, ObjectId } from 'mongodb';
import mongo from './mongo.js';


interface BasicCacheDoc extends MongoDocument {
    _id?: ObjectId | string | number; // Flexible _id for state, etc.
    name?: string; // Primarily for 'accounts'
    [key: string]: any;
}

type StandardCallback<T = any> = (err: Error | null, result?: T) => void;
type AsyncDbFunction = (callback: StandardCallback) => void;

interface CacheCollectionStore {
    [key: string]: BasicCacheDoc;
}

// Collections from the original TypeScript file structure
interface CacheCopyCollections {
    accounts: CacheCollectionStore;
    blocks: CacheCollectionStore;
    state: CacheCollectionStore;
    tokens: CacheCollectionStore;
    nftCollections: CacheCollectionStore;
    nfts: CacheCollectionStore;
    tradingPairs: CacheCollectionStore;
    orders: CacheCollectionStore;
    nftListings: CacheCollectionStore;
    nftBids: CacheCollectionStore;
    events: CacheCollectionStore;
    farms: CacheCollectionStore;
    userFarmPositions: CacheCollectionStore;
    userLiquidityPositions: CacheCollectionStore;
    trades: CacheCollectionStore;
    launchpads: CacheCollectionStore;
    liquidityPools: CacheCollectionStore;
    // Add other collections from original TS if they were in `copy`
}

interface CacheMainDataCollections {
    accounts: CacheCollectionStore;
    blocks: CacheCollectionStore;
    state: CacheCollectionStore;
    tokens: CacheCollectionStore;
    nftCollections: CacheCollectionStore;
    nfts: CacheCollectionStore;
    tradingPairs: CacheCollectionStore;
    orders: CacheCollectionStore;
    nftListings: CacheCollectionStore;
    nftBids: CacheCollectionStore;
    events: CacheCollectionStore;
    farms: CacheCollectionStore;
    userFarmPositions: CacheCollectionStore;
    userLiquidityPositions: CacheCollectionStore;
    trades: CacheCollectionStore;
    launchpads: CacheCollectionStore;
    liquidityPools: CacheCollectionStore;
    // Add other collections from original TS if they were direct properties
}

interface CacheType extends CacheMainDataCollections {
    copy: CacheCopyCollections;
    changes: Array<{ // Inline type definition
        collection: string;
        query: Filter<BasicCacheDoc>;
        changes: UpdateFilter<BasicCacheDoc> | Partial<BasicCacheDoc>;
    }>;
    inserts: Array<{ // Inline type definition
        collection: string;
        document: BasicCacheDoc;
    }>;
    rebuild: {
        changes: Array<{ // Inline type definition
            collection: string;
            query: Filter<BasicCacheDoc>;
            changes: UpdateFilter<BasicCacheDoc> | Partial<BasicCacheDoc>;
        }>;
        inserts: Array<{ // Inline type definition
            collection: string;
            document: BasicCacheDoc;
        }>;
    };
    witnesses: { [witnessName: string]: 1 };
    witnessChanges: [string, 0 | 1][];
    writerQueue: ProcessingQueue;

    rollback: () => void;
    findOnePromise: (collection: string, query: Filter<BasicCacheDoc>, skipClone?: boolean) => Promise<BasicCacheDoc | null>;
    findPromise: (collection: string, query: Filter<BasicCacheDoc>, options?: FindOptions<BasicCacheDoc>, skipClone?: boolean) => Promise<BasicCacheDoc[] | null>;
    findOne: (collection: string, query: Filter<BasicCacheDoc>, cb: StandardCallback<BasicCacheDoc | null>, skipClone?: boolean) => void;
    updateOnePromise: (collection: string, query: Filter<BasicCacheDoc>, changes: UpdateFilter<BasicCacheDoc> | Partial<BasicCacheDoc>) => Promise<boolean>;
    deleteOnePromise: (collection: string, query: Filter<BasicCacheDoc>) => Promise<boolean>;
    updateOne: (collection: string, query: Filter<BasicCacheDoc>, changes: UpdateFilter<BasicCacheDoc> | Partial<BasicCacheDoc>, cb: StandardCallback<boolean>) => void;
    updateMany: (collection: string, query: Filter<BasicCacheDoc>, changes: UpdateFilter<BasicCacheDoc> | Partial<BasicCacheDoc>, cb: StandardCallback<any[]>) => void;
    insertOne: (collection: string, document: BasicCacheDoc, cb: StandardCallback<boolean>) => void;
    addWitness: (witness: string, isRollback: boolean, cb: StandardCallback) => void;
    removeWitness: (witness: string, isRollback: boolean) => void;
    clear: () => void;
    writeToDisk: (rebuild: boolean, cb?: StandardCallback<any[]>) => void;
    processRebuildOps: (cb: StandardCallback, writeToDiskFlag: boolean) => void;
    keyByCollection: (collection: string) => string;
    warmup: (collection: string, maxDoc: number) => Promise<void>; // Modified to only handle 'accounts' from JS example
    warmupWitnesses: () => Promise<number>;
    _setNestedValue: (obj: any, path: string, value: any) => void; // Added for type safety
}

let db: Db | null = null; // Changed declaration

export const setMongoDbInstance = (mongoDbInstance: Db): void => {
    if (!mongoDbInstance) {
        logger.fatal('[CACHE] Attempted to set a null or undefined MongoDB instance to cache.');
        // It's often better to throw an error to stop execution if this critical dependency is missing.
        throw new Error('MongoDB instance cannot be null or undefined for cache setup.');
    }
    db = mongoDbInstance;
    logger.debug('[CACHE] MongoDB instance has been set.');
};

const cache: CacheType = {
    // Initialize with collections from the original TypeScript structure
    copy: {
        accounts: {}, blocks: {}, state: {}, tokens: {},
        nftCollections: {}, nfts: {}, tradingPairs: {}, orders: {},
        nftListings: {}, nftBids: {}, events: {}, farms: {}, userFarmPositions: {}, userLiquidityPositions: {},
        trades: {},
        launchpads: {},
        liquidityPools: {}
    },
    accounts: {}, blocks: {}, state: {}, tokens: {},
    nftCollections: {}, nfts: {}, tradingPairs: {}, orders: {},
    nftListings: {}, nftBids: {}, events: {}, farms: {}, userFarmPositions: {}, userLiquidityPositions: {},
    trades: {},
    launchpads: {},
    liquidityPools: {},

    changes: [],
    inserts: [],
    rebuild: {
        changes: [],
        inserts: []
    },
    witnesses: {},
    witnessChanges: [],
    writerQueue: new ProcessingQueue(),

    _setNestedValue: function (obj: any, path: string, value: any): void {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
    },

    rollback: function () {
        // rolling back changes from copied documents
        for (let c in this.copy) {
            const collectionKey = c as keyof CacheCopyCollections;
            if (this.copy[collectionKey]) { // Check if the collection exists on copy
                for (const key in this.copy[collectionKey]) {
                    if (this[collectionKey] && (this[collectionKey] as CacheCollectionStore)[key] && this.copy[collectionKey][key]) {
                        (this[collectionKey] as CacheCollectionStore)[key] = cloneDeep(this.copy[collectionKey][key]);
                    }
                }
                this.copy[collectionKey] = {};
            }
        }
        this.changes = [];

        // and discarding new inserts
        for (let i = 0; i < this.inserts.length; i++) {
            let toRemove = this.inserts[i];
            let key = this.keyByCollection(toRemove.collection);
            const collectionName = toRemove.collection as keyof CacheMainDataCollections;
            if (this[collectionName] && toRemove.document[key] !== undefined) {
                delete (this[collectionName] as CacheCollectionStore)[toRemove.document[key]];
            }
        }
        this.inserts = [];

        // reset witness changes
        for (let i = 0; i < this.witnessChanges.length; i++) { // Iterate over array properly
            const change = this.witnessChanges[i];
            if (change[1] === 0) {
                this.addWitness(change[0], true, () => { });
            } else if (change[1] === 1) {
                this.removeWitness(change[0], true);
            }
        }
        this.witnessChanges = [];
        // eco.nextBlock(); // Removed
    },

    findOnePromise: function (collection, query, skipClone) {
        return new Promise((rs, rj) => {
            this.findOne(collection, query, (e, d) => e ? rj(e) : rs(d === undefined ? null : d), skipClone);
        });
    },

    findPromise: async function (collection, query, options, skipClone) {
        if (!db) {
            logger.error(`[CACHE findPromise] Database not initialized for ${collection}.`);
            return Promise.resolve(null); // Or throw new Error('Database not initialized');
        }
        try {
            const documents = await db.collection<BasicCacheDoc>(collection).find(query, options).toArray();
            if (!documents || documents.length === 0) {
                return null;
            }
            // skipClone functionality is less critical for findPromise as it's a direct DB hit for multiple docs
            // and the primary caching layer is for single keyed access.
            // If cloning is desired, it would apply to each doc in the array.
            // For simplicity and typical use (read-only list), returning direct docs.
            return skipClone ? documents : documents.map(doc => cloneDeep(doc));
        } catch (err: any) {
            logger.error(`[CACHE findPromise] DB error querying ${collection}:`, err);
            // Depending on desired error handling, could throw err or return null
            // throw err; 
            return null;
        }
    },

    findOne: function (collection, query, cb, skipClone) {
        const collectionName = collection as keyof CacheMainDataCollections;

        // DEBUGGING LOGS START
        logger.debug(`[CACHE findOne] Checking collection: '${collection}', cast to collectionName: '${collectionName}'`);
        logger.debug(`[CACHE findOne] this.copy object keys: ${Object.keys(this.copy).join(', ')}`);
        logger.debug(`[CACHE findOne] Value of this.copy['${collectionName}']: ${JSON.stringify(this.copy[collectionName as keyof CacheCopyCollections])}`);
        // DEBUGGING LOGS END

        if (!this.copy[collectionName as keyof CacheCopyCollections]) { // Check against known copy collections
            logger.warn(`[CACHE findOne] Invalid collection in copy: '${collectionName}'. Available in copy: ${Object.keys(this.copy).join(', ')}`);
            return cb(new Error('invalid collection in copy'));
        }
        if (!db) return cb(new Error('Database not initialized'));

        let keyField = this.keyByCollection(collection);
        const docId = query[keyField];

        if (docId !== undefined && this[collectionName] && (this[collectionName] as CacheCollectionStore)[docId]) {
            const cachedDoc = (this[collectionName] as CacheCollectionStore)[docId];
            cb(null, skipClone ? cachedDoc : cloneDeep(cachedDoc));
            return;
        }

        db.collection<BasicCacheDoc>(collection).findOne(query)
            .then(obj => {
                if (!obj) {
                    cb(null, null); // Not found, explicitly return null for document
                    return;
                }
                if (obj[keyField] !== undefined && this[collectionName]) {
                    (this[collectionName] as CacheCollectionStore)[obj[keyField]] = obj;
                }
                cb(null, skipClone ? obj : cloneDeep(obj));
            })
            .catch(err => {
                logger.error(`[CACHE findOne] DB error querying ${collection}:`, err);
                cb(err);
            });
    },

    updateOnePromise: function (collection, query, changes) {
        return new Promise((rs, rj) => {
            this.updateOne(collection, query, changes, (e, d) => e ? rj(e) : rs(d || false));
        });
    },

    deleteOnePromise: async function (collection, query) {
        if (!db) {
            logger.error(`[CACHE deleteOnePromise] Database not initialized for ${collection}.`);
            return Promise.resolve(false);
        }
        try {
            // Before deleting from DB, remove from in-memory cache if it exists
            const collectionName = collection as keyof CacheMainDataCollections;
            const keyField = this.keyByCollection(collection);
            const docId = query[keyField]; // This assumes the query directly contains the keyField for simple lookups

            if (docId !== undefined && this[collectionName] && (this[collectionName] as CacheCollectionStore)[docId]) {
                delete (this[collectionName] as CacheCollectionStore)[docId];
                logger.debug(`[CACHE deleteOnePromise] Removed ${collection}/${docId} from in-memory store.`);
            }
            // Also remove from copy if it exists there (though less likely to be hit directly for a delete operation)
            if (docId !== undefined && this.copy[collectionName as keyof CacheCopyCollections] && (this.copy[collectionName as keyof CacheCopyCollections] as CacheCollectionStore)[docId]) {
                delete (this.copy[collectionName as keyof CacheCopyCollections] as CacheCollectionStore)[docId];
                logger.debug(`[CACHE deleteOnePromise] Removed ${collection}/${docId} from copy store.`);
            }

            const result = await db.collection<BasicCacheDoc>(collection).deleteOne(query);

            // Add to changes array for writeToDisk to eventually process (if this is part of a transaction block)
            // However, direct DB modification bypasses the usual change tracking for rollback of in-memory state.
            // For simplicity here, this method directly modifies DB and in-memory state.
            // A more complex implementation would queue a delete operation for writeToDisk.
            if (result.deletedCount && result.deletedCount > 0) {
                // For now, we don't add to this.changes for deletions, as writeToDisk mainly handles inserts/updates.
                // If deletion needs to be part of the batching/rollback system, this needs more thought.
                logger.debug(`[CACHE deleteOnePromise] Successfully deleted document from ${collection} matching query:`, query);
                return true;
            } else {
                logger.warn(`[CACHE deleteOnePromise] No document found in ${collection} to delete for query:`, query);
                return false;
            }
        } catch (err: any) {
            logger.error(`[CACHE deleteOnePromise] DB error deleting from ${collection}:`, err);
            return false;
        }
    },

    updateOne: function (collection, query, changes, cb) {
        if (!db) return cb(new Error('Database not initialized'));
        const collectionName = collection as keyof CacheMainDataCollections;
        const copyCollectionName = collection as keyof CacheCopyCollections;

        this.findOne(collection, query, (err, obj) => {
            if (err) { cb(err); return; }
            if (!obj) {
                cb(null, false); return;
            }
            let keyField = this.keyByCollection(collection);
            const docId = obj[keyField];

            if (docId === undefined) {
                cb(new Error('Document ID is undefined after findOne in updateOne.'));
                return;
            }

            const liveCollection = (this[collectionName] as CacheCollectionStore);
            const copyCollection = (this.copy[copyCollectionName] as CacheCollectionStore);

            // Ensure chain.getLatestBlock() is checked for null/undefined before accessing _id
            const latestBlock = chain.getLatestBlock();
            if (copyCollection && !copyCollection[docId] &&
                (!chain.restoredBlocks || (latestBlock && latestBlock._id >= chain.restoredBlocks))) {
                if (liveCollection && liveCollection[docId]) {
                    copyCollection[docId] = cloneDeep(liveCollection[docId]);
                }
            }

            const targetDoc = liveCollection ? liveCollection[docId] : null;
            if (!targetDoc) {
                cb(new Error(`Document ${collection}/${docId} not found in live cache for update.`));
                return;
            }

            for (const op in changes) {
                const opArgs = changes[op];
                if (!opArgs) continue;

                switch (op) {
                    case '$inc':
                        for (const fieldPath in opArgs) {
                            // Note: This $inc logic also needs dot notation handling if used for nested fields.
                            // For now, assuming it's used for top-level or we address it separately.
                            const keys = fieldPath.split('.');
                            let current = targetDoc;
                            for (let i = 0; i < keys.length - 1; i++) {
                                if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
                                    current[keys[i]] = {}; // Initialize nested path for $inc
                                }
                                current = current[keys[i]];
                            }
                            current[keys[keys.length - 1]] = (current[keys[keys.length - 1]] || 0) + opArgs[fieldPath];
                        }
                        break;
                    case '$push':
                        for (const fieldPath in opArgs) {
                            const keys = fieldPath.split('.');
                            let current: any = targetDoc;
                            let validPath = true;
                            for (let i = 0; i < keys.length - 1; i++) {
                                if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
                                    current[keys[i]] = {};
                                }
                                current = current[keys[i]];
                            }
                            const arrField = keys[keys.length - 1];
                            if (!current[arrField] || !Array.isArray(current[arrField])) current[arrField] = [];
                            current[arrField].push(opArgs[fieldPath]);
                        }
                        break;
                    case '$pull':
                        for (const fieldPath in opArgs) {
                            const keys = fieldPath.split('.');
                            let current: any = targetDoc;
                            let validPath = true;
                            for (let i = 0; i < keys.length - 1; i++) {
                                if (!current || typeof current[keys[i]] !== 'object') {
                                    validPath = false;
                                    break;
                                }
                                current = current[keys[i]];
                            }
                            if (!validPath || !current) continue; // Path did not fully exist or became null

                            const arrField = keys[keys.length - 1];
                            if (Array.isArray(current[arrField])) {
                                const condition = opArgs[fieldPath];
                                if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
                                    current[arrField] = current[arrField].filter((item: any) =>
                                        !Object.keys(condition).every(k => item[k] === condition[k])
                                    );
                                } else {
                                    current[arrField] = current[arrField].filter((item: any) => item !== condition);
                                }
                            }
                        }
                        break;
                    case '$set':
                        for (const fieldPath in opArgs) {
                            this._setNestedValue(targetDoc, fieldPath, opArgs[fieldPath]);
                        }
                        break;
                    case '$unset':
                        for (const fieldPath in opArgs) {
                            const keys = fieldPath.split('.');
                            let current: any = targetDoc;
                            let validPath = true;
                            for (let i = 0; i < keys.length - 1; i++) {
                                if (!current || typeof current[keys[i]] !== 'object') {
                                    validPath = false;
                                    break;
                                }
                                current = current[keys[i]];
                            }
                            if (validPath && current) {
                                delete current[keys[keys.length - 1]];
                            }
                        }
                        break;
                    default:
                        logger.warn(`[CACHE updateOne] Unsupported operator: ${op}`);
                        break;
                }
            }

            this.changes.push({ collection: collection, query: query, changes: changes });
            cb(null, true);
        }, true); // skipClone = true for findOne
    },

    updateMany: function (collection, query, changes, cb) {
        let keyField = this.keyByCollection(collection);
        const idsToUpdate = query[keyField]?.$in;

        if (!idsToUpdate || !Array.isArray(idsToUpdate)) {
            const errMsg = 'updateMany requires a query with $in operator on the key field (e.g., { name: { $in: [...] } })';
            logger.error(`[CACHE updateMany] ${errMsg}`);
            cb(new Error(errMsg));
            return;
        }

        let executions: AsyncDbFunction[] = [];
        for (let i = 0; i < idsToUpdate.length; i++) {
            executions.push((callback) => {
                let newQuery: Filter<BasicCacheDoc> = {};
                newQuery[keyField] = idsToUpdate[i];
                this.updateOne(collection, newQuery, changes, (err, result) => {
                    callback(err ?? null, result); // Ensure err is Error | null
                });
            });
        }

        parallel(executions, (err: Error | null, results: any) => {
            cb(err ?? null, results as any[]);
        });
    },

    insertOne: function (collection, document, cb) {
        const collectionName = collection as keyof CacheMainDataCollections;
        let keyField = this.keyByCollection(collection);
        const docId = document[keyField];

        if (docId !== undefined && this[collectionName] && (this[collectionName] as CacheCollectionStore)[docId]) {
            cb(null, false);
            return;
        }

        if (this[collectionName]) {
            if (docId !== undefined) {
                (this[collectionName] as CacheCollectionStore)[docId] = document;
            } else {
                // Handle documents without a predefined key if necessary, though JS logic implies key exists
                logger.warn(`[CACHE insertOne] Document for ${collection} missing keyField '${keyField}'. DB will assign _id if this was the intended key.`);
            }
        }

        this.inserts.push({ collection: collection, document: document });
        cb(null, true);
    },

    addWitness: function (witness, isRollback, cb) {
        if (!this.witnesses[witness]) {
            this.witnesses[witness] = 1;
        }
        if (!isRollback) {
            this.witnessChanges.push([witness, 1]);
        }
        this.findOne('accounts', { name: witness }, (err, data) => {
            if (err) {
                cb(err, null);
            } else {
                cb(null, witness);
            }
        });
    },

    removeWitness: function (witness, isRollback) {
        if (this.witnesses[witness]) {
            delete this.witnesses[witness];
        }
        if (!isRollback) {
            this.witnessChanges.push([witness, 0]);
        }
    },

    clear: function () {
        this.changes = [];
        this.inserts = [];
        this.rebuild.changes = [];
        this.rebuild.inserts = [];
        this.witnessChanges = [];
        for (let c in this.copy) {
            const collectionKey = c as keyof CacheCopyCollections;
            if (this.copy[collectionKey]) {
                this.copy[collectionKey] = {};
            }
        }
    },

    writeToDisk: function (rebuild, cb) {
        if (!db) {
            const err = new Error('Database not initialized for writeToDisk');
            logger.error(err.message);
            if (cb) cb(err);
            return;
        }
        const currentDb = db; // db is confirmed to be non-null here

        const bulkOpsByCollection: { [collectionName: string]: any[] } = {};

        // Helper to initialize bulkOps for a collection
        const ensureBulkOpsForCollection = (collectionName: string) => {
            if (!bulkOpsByCollection[collectionName]) {
                bulkOpsByCollection[collectionName] = [];
            }
        };

        // 1. Process Inserts
        const insertArr = rebuild ? this.rebuild.inserts : this.inserts;
        for (let i = 0; i < insertArr.length; i++) {
            const insertOp = insertArr[i];
            ensureBulkOpsForCollection(insertOp.collection);
            bulkOpsByCollection[insertOp.collection].push({
                insertOne: {
                    document: insertOp.document
                }
            });
        }

        // 2. Process Changes (now as updateOne operations)
        const changesArr = rebuild ? this.rebuild.changes : this.changes;
        for (let i = 0; i < changesArr.length; i++) {
            const changeOp = changesArr[i]; // changeOp is { collection, query, changes }
            const collection = changeOp.collection;

            if (changeOp.query && changeOp.changes && Object.keys(changeOp.changes).length > 0) {
                ensureBulkOpsForCollection(collection);
                // The `changeOp.changes` should already be in the correct MongoDB update operator format
                // e.g., { $set: { field: value }, $inc: { counter: 1 } }
                // The `changeOp.query` is the filter document.
                bulkOpsByCollection[collection].push({
                    updateOne: {
                        filter: changeOp.query,
                        update: changeOp.changes,
                        upsert: true // Keep upsert:true, was used with replaceOne and generally safe for updateOne
                    }
                });
            } else {
                 logger.warn(`[CACHE writeToDisk Refactor] Skipped invalid or empty changeOp for ${collection} updateOne. Query: ${JSON.stringify(changeOp.query)}, Changes: ${JSON.stringify(changeOp.changes)}`);
            }
        }

        // 3. Prepare executions for bulkWrites
        let dbExecutions: Promise<any>[] = [];
        for (const collectionName in bulkOpsByCollection) {
            if (bulkOpsByCollection[collectionName].length > 0) {
                logger.debug(`[CACHE writeToDisk Refactor] Preparing bulkWrite for ${collectionName} with ${bulkOpsByCollection[collectionName].length} ops.`);
                dbExecutions.push(
                    currentDb.collection(collectionName).bulkWrite(bulkOpsByCollection[collectionName], { ordered: false })
                );
            }
        }
        
        // 4. Handle other specific updates (txHistory, witnessesStats, state)
        // These are not easily batched with the above, keep them as separate ops for now,
        // or convert them to bulkWrite if they consistently target the same collections and can be structured as bulk ops.
        let singleOpExecutions: AsyncDbFunction[] = [];

        if (process.env.WITNESS_STATS === '1' && witnessesStats && typeof witnessesStats.getWriteOps === 'function') {
            try {
                const witnessesStatsWriteOps = witnessesStats.getWriteOps();
                if (Array.isArray(witnessesStatsWriteOps)) {
                    // Assuming these are already {updateOne: ...} or similar, or functions taking a callback
                    // If they are functions (callback) as before:
                    singleOpExecutions.push(...(witnessesStatsWriteOps as AsyncDbFunction[]));
                }
            } catch (e) {
                logger.error('[CACHE writeToDisk] Error getting witnessesStats write ops:', e);
            }
        }

        if (process.env.TX_HISTORY === '1' && txHistory && typeof txHistory.getWriteOps === 'function') {
            try {
                const txHistoryWriteOps = txHistory.getWriteOps();
                if (Array.isArray(txHistoryWriteOps)) {
                    singleOpExecutions.push(...(txHistoryWriteOps as AsyncDbFunction[]));
                }
            } catch (e) {
                logger.error('[CACHE writeToDisk] Error getting txHistory write ops:', e);
            }
        }

        const latestBlock = chain.getLatestBlock();
        if (latestBlock && latestBlock._id !== undefined) {
            const stateQuery: Filter<BasicCacheDoc> = { _id: 0 };
            const stateUpdate = { $set: { headBlock: latestBlock._id } };
            singleOpExecutions.push((callback) => {
                currentDb.collection<BasicCacheDoc>('state').updateOne(stateQuery, stateUpdate, { upsert: true })
                    .then(() => callback(null, true))
                    .catch(err => {
                        logger.error('[CACHE writeToDisk] State update error:', err);
                        callback(err);
                    });
            });
        } else {
            logger.warn('[CACHE writeToDisk] Skipping state update, latest block or _id is undefined.');
        }

        const allOpsDoneCallback = (err?: Error | null, results?: any[]) => {
            if (!err) {
                if (!rebuild) { // Original JS only cleared non-rebuild, specific items for rebuild in processRebuildOps
                    this.clear();
                } else {
                    // For rebuild, specific clear happens in processRebuildOps
                    this.rebuild.inserts = [];
                    this.rebuild.changes = [];
                    // witnessChanges are cleared in processRebuildOps
                }
            } else {
                logger.error('[CACHE writeToDisk] Batch failed. Cache not cleared (or partially cleared for rebuild).', err);
            }
            if (cb) {
                cb(err ?? null, results);
            }
        };

        const totalBulkOps = dbExecutions.length;
        const totalSingleOps = singleOpExecutions.length;

        if (totalBulkOps === 0 && totalSingleOps === 0) {
            logger.debug('[CACHE writeToDisk Refactor] No DB operations for this batch.');
            allOpsDoneCallback(null, []);
            return;
        }

        const executeAllOperations = () => {
            let timeBefore = new Date().getTime();
            Promise.all(dbExecutions)
                .then(bulkResults => {
                    // Now execute single operations if any bulk ops succeeded or if no bulk ops
                    if (singleOpExecutions.length > 0) {
                        parallel(singleOpExecutions, (singleErr: Error | null, singleResults: any) => {
                            let execTime = new Date().getTime() - timeBefore;
                            if (singleErr) {
                                logger.error('[CACHE writeToDisk Refactor] Error in single operations part of batch:', singleErr);
                            }
                            // Combine results if needed, or just pass singleResults
                            const finalResults = (bulkResults || []).concat(singleResults || []);
                            logTimingAndCallDone(singleErr, finalResults, execTime);
                        });
                    } else {
                        let execTime = new Date().getTime() - timeBefore;
                        logTimingAndCallDone(null, bulkResults, execTime);
                    }
                })
                .catch(bulkErr => {
                    let execTime = new Date().getTime() - timeBefore;
                    logger.error('[CACHE writeToDisk Refactor] Error in bulkWrite operations:', bulkErr);
                    logTimingAndCallDone(bulkErr, [], execTime); // Pass empty results on bulk error
                });
        };
        
        const logTimingAndCallDone = (err: Error | null, results: any[], execTime: number) => {
            const numOps = insertArr.length + changesArr.length + singleOpExecutions.length; // Approximate total original ops
            if (config && config.blockTime && !rebuild && execTime >= config.blockTime / 2) {
                logger.warn(`[CACHE writeToDisk Refactor] Slow DB batch: ${numOps} original ops (${totalBulkOps} bulk, ${totalSingleOps} single), ${execTime}ms`);
            } else {
                logger.debug(`[CACHE writeToDisk Refactor] DB batch took ${execTime}ms for ${numOps} original ops (${totalBulkOps} bulk, ${totalSingleOps} single).`);
            }
            allOpsDoneCallback(err ?? null, results as any[]);
        };


        if (typeof cb === 'function') {
            executeAllOperations();
        } else {
            logger.debug(`[CACHE writeToDisk Refactor] Queuing ${totalBulkOps} bulk and ${totalSingleOps} single DB ops.`);
            this.writerQueue.push((queueCb: StandardCallback) => {
                executeAllOperations();
            });
        }
    },

    processRebuildOps: function (cb, writeToDiskFlag) {
        this.rebuild.inserts.push(...this.inserts);
        this.rebuild.changes.push(...this.changes);
        this.inserts = [];
        this.changes = [];
        this.witnessChanges = []; // As per JS logic
        for (let c in this.copy) {
            const collectionKey = c as keyof CacheCopyCollections;
            if (this.copy[collectionKey]) {
                this.copy[collectionKey] = {};
            }
        }
        if (writeToDiskFlag) {
            this.writeToDisk(true, cb);
        } else {
            if (cb) cb(null);
        }
    },

    keyByCollection: function (collection: string): string {
        switch (collection) {
            case 'accounts': return 'name';
            default: return '_id';
        }
    },

    // Warmup only implements 'accounts' as 'contents' is not in the target collection structure
    warmup: async function (collection: string, maxDoc: number): Promise<void> {
        if (!db) {
            logger.error(`[CACHE warmup] Database not initialized for ${collection}.`);
            return Promise.resolve();
        }
        if (!collection || !maxDoc || maxDoc === 0) {
            return Promise.resolve();
        }

        const options: FindOptions = { limit: maxDoc };

        switch (collection) {
            case 'accounts':
                options.sort = { totalVoteWeight: -1, name: -1 };
                try {
                    const accountsDocs = await db.collection<BasicCacheDoc>(collection).find({}, options).toArray();
                    for (let i = 0; i < accountsDocs.length; i++) {
                        const acc = accountsDocs[i];
                        if (acc.name !== undefined) {
                            (this.accounts as CacheCollectionStore)[acc.name] = acc;
                        }
                    }
                    logger.debug(`[CACHE warmup] Warmed up ${accountsDocs.length} accounts.`);
                } catch (err) {
                    logger.error(`[CACHE warmup] Error warming up ${collection}:`, err);
                    throw err;
                }
                break;
            case 'tokens':
                options.sort = { totalVoteWeight: -1, name: -1 };
                try {
                    const tokensDocs = await db.collection<BasicCacheDoc>(collection).find({}, options).toArray();
                    for (let i = 0; i < tokensDocs.length; i++) {
                        const token = tokensDocs[i];
                        if (token.identifier !== undefined) {
                            (this.tokens as CacheCollectionStore)[token.identifier] = token;
                        }
                    }
                    logger.debug(`[CACHE warmup] Warmed up ${tokensDocs.length} tokens.`);
                } catch (err) {
                    logger.error(`[CACHE warmup] Error warming up ${collection}:`, err);
                    throw err;
                }
                break;
            // 'contents' logic from JS is omitted as it's not in the target collection set.
            default:
                logger.warn(`[CACHE warmup] Collection type '${collection}' not implemented for warmup in this configuration.`);
                // Original JS would reject, returning resolve to not break Promise.all if used elsewhere
                return Promise.resolve();
        }
    },

    warmupWitnesses: async function (): Promise<number> {

        try {
            const accs = await mongo.getDb().collection('accounts').find({
                $and: [
                    { witnessPublicKey: { $exists: true } },
                    { witnessPublicKey: { $ne: '' } }
                ]
            }).toArray();
            for (let i in accs) {
                const name = accs[i].name;
                if (typeof name === 'string' && name.length > 0) {
                    cache.witnesses[name] = 1;
                    if (!cache.accounts[name])
                        cache.accounts[name] = accs[i];
                }
            }
            logger.debug(`[CACHE warmupWitnesses] Warmed up ${accs.length} witnesses.`);
            return accs.length;
        } catch (e) {
            logger.error('[CACHE warmupWitnesses] Error:', e);
            throw e;
        }
    }
};

export default cache;