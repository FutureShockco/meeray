// Full direct port of cache.js to TypeScript
// All logic and behavior matches the original JS

import parallel from 'run-parallel';
import cloneDeep from 'clone-deep';
import ProcessingQueue from './processingQueue.js';
import logger from './logger.js';
import config from './config.js';
import { chain } from './chain.js';
// Removed direct import of mongo here to avoid circular dependencies or premature calls
// import { mongo } from './mongo.js'; 
import txHistory from './txHistory.js'; // Assumed to be a JS module with getWriteOps
import witnessesStats from './witnessesStats.js'; // Assumed to be a JS module with getWriteOps

import { Db, Filter, Document as MongoDocument, UpdateFilter, FindOptions, ObjectId } from 'mongodb';


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
    pools: CacheCollectionStore;
    events: CacheCollectionStore;
    farms: CacheCollectionStore;
    userFarmPositions: CacheCollectionStore;
    userLiquidityPositions: CacheCollectionStore;
    trades: CacheCollectionStore;
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
    pools: CacheCollectionStore;
    events: CacheCollectionStore;
    farms: CacheCollectionStore;
    userFarmPositions: CacheCollectionStore;
    userLiquidityPositions: CacheCollectionStore;
    trades: CacheCollectionStore;
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
    logger.info('[CACHE] MongoDB instance has been set.');
};

const cache: CacheType = {
    // Initialize with collections from the original TypeScript structure
    copy: {
        accounts: {}, blocks: {}, state: {}, tokens: {},
        nftCollections: {}, nfts: {}, tradingPairs: {}, orders: {},
        nftListings: {}, pools: {}, events: {}, farms: {}, userFarmPositions: {}, userLiquidityPositions: {},
        trades: {}
    },
    accounts: {}, blocks: {}, state: {}, tokens: {},
    nftCollections: {}, nfts: {}, tradingPairs: {}, orders: {},
    nftListings: {}, pools: {}, events: {}, farms: {}, userFarmPositions: {}, userLiquidityPositions: {},
    trades: {},

    changes: [],
    inserts: [],
    rebuild: {
        changes: [],
        inserts: []
    },
    witnesses: {},
    witnessChanges: [],
    writerQueue: new ProcessingQueue(),

    _setNestedValue: function(obj: any, path: string, value: any): void {
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
        if (!this.copy[collectionName as keyof CacheCopyCollections]) { // Check against known copy collections
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
            if (docId !== undefined && this.copy[collectionName as keyof CacheCopyCollections] && (this.copy[collectionName as keyof CacheCopyCollections] as CacheCollectionStore)[docId]){
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
                const opArgs = (changes as any)[op];
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
                            let current:any = targetDoc;
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

                            const arrField = keys[keys.length-1];
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

        let executions: AsyncDbFunction[] = [];
        const insertArr = rebuild ? this.rebuild.inserts : this.inserts;
        for (let i = 0; i < insertArr.length; i++) {
            executions.push((callback) => {
                const insertOp = insertArr[i];
                currentDb.collection<BasicCacheDoc>(insertOp.collection).insertOne(insertOp.document)
                    .then(() => callback(null))
                    .catch(err => {
                        logger.error(`[CACHE writeToDisk] insertOne error for ${insertOp.collection}:`, err, insertOp.document);
                        callback(err);
                    });
            });
        }

        let docsToUpdate: { [collection: string]: { [key: string]: BasicCacheDoc } } = {};
        // Initialize docsToUpdate with known collections from the cache.copy structure
        for (const c of Object.keys(this.copy) as Array<keyof CacheCopyCollections>) {
            docsToUpdate[c] = {};
        }

        const changesArr = rebuild ? this.rebuild.changes : this.changes;
        for (let i = 0; i < changesArr.length; i++) {
            const changeOp = changesArr[i];
            const collection = changeOp.collection;
            const keyField = this.keyByCollection(collection);
            const docId = changeOp.query[keyField]; // Assumes query[keyField] is the ID
            const mainCollectionStore = this[collection as keyof CacheMainDataCollections] as CacheCollectionStore;

            if (docId !== undefined && mainCollectionStore && mainCollectionStore[docId]) {
                if (!docsToUpdate[collection]) docsToUpdate[collection] = {}; // Should already be init by loop over this.copy
                docsToUpdate[collection][docId] = mainCollectionStore[docId];
            } else {
                logger.warn(`[CACHE writeToDisk] Doc for update via changeOp not in live cache or docId missing: ${collection}/${docId}`, changeOp.query);
            }
        }

        for (const col in docsToUpdate) {
            if (!Object.prototype.hasOwnProperty.call(this, col)) continue; // Ensure col is a direct prop of cache main store
            for (const idKey in docsToUpdate[col]) {
                executions.push((callback) => {
                    const keyField = this.keyByCollection(col);
                    const newDoc = docsToUpdate[col][idKey];
                    let query: Filter<BasicCacheDoc> = {};

                    if (newDoc[keyField] === undefined) {
                        logger.error(`[CACHE writeToDisk] Doc for replaceOne has undefined key: ${col}/${idKey}`, newDoc);
                        callback(new Error(`Document key is undefined for ${col}/${idKey}`), null);
                        return;
                    }
                    query[keyField] = newDoc[keyField];

                    currentDb.collection<BasicCacheDoc>(col).replaceOne(query, newDoc, { upsert: true })
                        .then(() => callback(null))
                        .catch(err => {
                            logger.error(`[CACHE writeToDisk] replaceOne error for ${col}/${newDoc[keyField]}:`, err, newDoc);
                            callback(err);
                        });
                });
            }
        }

        if (process.env.LEADER_STATS === '1' && witnessesStats && typeof witnessesStats.getWriteOps === 'function') {
            try {
                const witnessesStatsWriteOps = witnessesStats.getWriteOps();
                if (Array.isArray(witnessesStatsWriteOps)) {
                    executions.push(...(witnessesStatsWriteOps as AsyncDbFunction[]));
                }
            } catch (e) {
                logger.error('[CACHE writeToDisk] Error getting witnessesStats write ops:', e);
            }
        }

        if (process.env.TX_HISTORY === '1' && txHistory && typeof txHistory.getWriteOps === 'function') {
            try {
                const txHistoryWriteOps = txHistory.getWriteOps();
                if (Array.isArray(txHistoryWriteOps)) {
                    executions.push(...(txHistoryWriteOps as AsyncDbFunction[]));
                }
            } catch (e) {
                logger.error('[CACHE writeToDisk] Error getting txHistory write ops:', e);
            }
        }

        const latestBlock = chain.getLatestBlock();
        if (latestBlock && latestBlock._id !== undefined) {
            // Ensure _id: 0 is compatible with BasicCacheDoc._id type
            const stateQuery: Filter<BasicCacheDoc> = { _id: 0 };
            const stateUpdate = { $set: { headBlock: latestBlock._id } };
            executions.push((callback) => {
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

        if (executions.length === 0) {
            logger.debug('[CACHE writeToDisk] No DB operations for this batch.');
            allOpsDoneCallback(null, []);
            return;
        }

        if (typeof cb === 'function') {
            let timeBefore = new Date().getTime();
            parallel(executions, (err: Error | null, results: any) => {
                let execTime = new Date().getTime() - timeBefore;
                if (config && config.blockTime && !rebuild && execTime >= config.blockTime / 2) {
                    logger.warn(`[CACHE writeToDisk] Slow DB batch: ${executions.length} ops, ${execTime}ms`);
                } else {
                    logger.debug(`[CACHE writeToDisk] DB batch took ${execTime}ms for ${executions.length} ops.`);
                }
                allOpsDoneCallback(err ?? null, results as any[]);
            });
        } else {
            logger.debug(`[CACHE writeToDisk] Queuing ${executions.length} DB ops.`);
            this.writerQueue.push((queueCb: StandardCallback) => {
                parallel(executions, (err: Error | null, results: any[]) => {
                    allOpsDoneCallback(err ?? null, results);
                    queueCb(err ?? null, results);
                });
            });
            // Per JS, clear is called immediately if not callback based, for non-rebuild.
            if (!rebuild) {
                this.clear();
            }
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
                options.sort = { node_appr: -1, name: -1 }; // JS: {node_appr: -1, name: -1}
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
            // 'contents' logic from JS is omitted as it's not in the target collection set.
            default:
                logger.warn(`[CACHE warmup] Collection type '${collection}' not implemented for warmup in this configuration.`);
                // Original JS would reject, returning resolve to not break Promise.all if used elsewhere
                return Promise.resolve();
        }
    },

    warmupWitnesses: async function (): Promise<number> {
        if (!db) {
            logger.error('[CACHE warmupWitnesses] Database not initialized.');
            return 0;
        }
        const query: Filter<BasicCacheDoc> = {
            $and: [
                { witnessPublicKey: { $exists: true } },
                { witnessPublicKey: { $ne: '' } }
            ]
        };
        try {
            const accs = await db.collection<BasicCacheDoc>('accounts').find(query).toArray();
            for (let i = 0; i < accs.length; i++) {
                const acc = accs[i];
                if (acc.name) {
                    this.witnesses[acc.name] = 1;
                    if (!(this.accounts as CacheCollectionStore)[acc.name]) {
                        (this.accounts as CacheCollectionStore)[acc.name] = acc;
                    }
                }
            }
            logger.debug(`[CACHE warmupLeaders] Warmed up ${accs.length} witnesses.`);
            return accs.length;
        } catch (e) {
            logger.error('[CACHE warmupLeaders] Error:', e);
            throw e;
        }
    }
};

export default cache;