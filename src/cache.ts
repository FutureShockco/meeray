// Full direct port of cache.js to TypeScript
// All logic and behavior matches the original JS

import parallel from 'run-parallel';
import cloneDeep from 'clone-deep';
import { Account } from './models/account.js';
import { BlockModel } from './models/block.js';
import ProcessingQueue from './processingQueue.js';
import StateModel from './models/state.js';
import logger from './logger.js';
import witnessesStats from './witnessesStats.js';
import txHistory from './transactions/txHistory.js';
import config from './config.js';
import { chain } from './chain.js';
import { NotificationModel } from './models/notification.js';
import WitnessStatsModel from './models/witnessStats.js';
import { TokenModel } from './models/token.js';
const modelMap: Record<string, any> = {
    accounts: Account,
    tokens: TokenModel,
    blocks: BlockModel,
    state: StateModel,
    notifications: NotificationModel,
    witnessStats: WitnessStatsModel
};

function assertModelExists(collection: string) {
    if (!modelMap[collection]) {
        logger.warn(`[CACHE] No model found for collection: '${collection}'. Check modelMap and collection keys.`);
        return false;
    }
    return true;
}

const CacheStorage: any = {
    copy: {
        accounts: {},
        blocks: {},
        state: {},
        tokens: {},
        nftCollections: {},
        nfts: {},
        markets: {},
        orders: {},
        nftMarket: {},
        pools: {},
        events: {},
        farms: {},
        farmStakes: {}
    },
    accounts: {},
    blocks: {},
    state: {},
    tokens: {},
    nftCollections: {},
    nfts: {},
    markets: {},
    orders: {},
    nftMarket: {},
    pools: {},
    events: {},
    farms: {},
    farmStakes: {},
    changes: [],
    inserts: [],
    rebuild: { changes: [], inserts: [] },
    leaders: {}, leaderChanges: [],
    writerQueue: new ProcessingQueue(),
    rollback: function () {
        for (let c in cache.copy) {
            for (const key in cache.copy[c])
                cache[c][key] = cloneDeep(cache.copy[c][key]);
            cache.copy[c] = {};
        }
        cache.changes = [];
        for (let i = 0; i < cache.inserts.length; i++) {
            let toRemove = cache.inserts[i];
            let key = cache.keyByCollection(toRemove.collection);
            delete cache[toRemove.collection][toRemove.document[key]];
        }
        cache.inserts = [];
        for (let i in cache.leaderChanges)
            if (cache.leaderChanges[i][1] === 0)
                cache.addLeader(cache.leaderChanges[i][0], true, () => { });
            else if (cache.leaderChanges[i][1] === 1)
                cache.removeLeader(cache.leaderChanges[i][0], true);
        cache.leaderChanges = [];
    },
    findOnePromise: function (collection: string, query: any, skipClone?: boolean) {
        return new Promise((rs, rj) => cache.findOne(collection, query, (e: any, d: any) => e ? rj(e) : rs(d), skipClone));
    },
    findOne: function (collection: string, query: any, cb: Function, skipClone?: boolean) {
        if (!cache.copy[collection])
            return cb('invalid collection');
        if (!assertModelExists(collection))
            return cb('invalid collection');
        let key = cache.keyByCollection(collection);
        if (cache[collection][query[key]]) {
            if (!skipClone)
                cb(null, cloneDeep(cache[collection][query[key]]));
            else
                cb(null, cache[collection][query[key]]);
            return;
        }
        const model = modelMap[collection];
        model.findOne(query, function (err: any, obj: any) {
            if (err) logger.debug('error cache');
            else {
                if (!obj) { cb(); return; }
                cache[collection][obj[key]] = obj;
                if (!skipClone)
                    cb(null, cloneDeep(obj));
                else
                    cb(null, obj);
            }
        });
    },
    updateOnePromise: function (collection: string, query: any, changes: any) {
        return new Promise((rs, rj) => cache.updateOne(collection, query, changes, (e: any, d: any) => e ? rj(e) : rs(true)));
    },
    updateOne: function (collection: string, query: any, changes: any, cb: Function) {
        cache.findOne(collection, query, function (err: any, obj: any) {
            if (err) throw err;
            if (!obj) { cb(null, false); return; }
            let key = cache.keyByCollection(collection);
            if (!cache.copy[collection][obj[key]] && (!chain.restoredBlocks || chain.getLatestBlock()._id >= chain.restoredBlocks))
                cache.copy[collection][obj[key]] = cloneDeep(cache[collection][obj[key]]);
            for (let c in changes)
                switch (c) {
                    case '$inc':
                        for (let i in changes[c])
                            if (!cache[collection][obj[key]][i])
                                cache[collection][obj[key]][i] = changes[c][i];
                            else
                                cache[collection][obj[key]][i] += changes[c][i];
                        break;
                    case '$push':
                        for (let p in changes[c]) {
                            if (!cache[collection][obj[key]][p])
                                cache[collection][obj[key]][p] = [];
                            cache[collection][obj[key]][p].push(changes[c][p]);
                        }
                        break;
                    case '$pull':
                        for (let l in changes[c])
                            for (let y = 0; y < cache[collection][obj[key]][l].length; y++)
                                if (typeof changes[c][l] === 'object') {
                                    let matching = true;
                                    for (const v in changes[c][l])
                                        if (cache[collection][obj[key]][l][y][v] !== changes[c][l][v]) {
                                            matching = false;
                                            break;
                                        }
                                    if (matching)
                                        cache[collection][obj[key]][l].splice(y, 1);
                                } else if (cache[collection][obj[key]][l][y] === changes[c][l])
                                    cache[collection][obj[key]][l].splice(y, 1);
                        break;
                    case '$set':
                        for (let s in changes[c])
                            cache[collection][obj[key]][s] = changes[c][s];
                        break;
                    case '$unset':
                        for (let u in changes[c])
                            delete cache[collection][obj[key]][u];
                        break;
                    default:
                        break;
                }
            cache.changes.push({ collection: collection, query: query, changes: changes });
            cb(null, true);
        }, true);
    },
    updateMany: function (collection: string, query: any, changes: any, cb: Function) {
        let key = cache.keyByCollection(collection);
        if (!query[key] || !query[key]['$in'])
            throw 'updateMany requires a $in operator';
        let indexesToUpdate = query[key]['$in'];
        let executions: any[] = [];
        for (let i = 0; i < indexesToUpdate.length; i++)
            executions.push(function (callback: any) {
                let newQuery: any = {};
                newQuery[key] = indexesToUpdate[i];
                cache.updateOne(collection, newQuery, changes, function (err: any, result: any) {
                    callback(null, result);
                });
            });
        parallel(executions, function (err: any, results: any) {
            cb(err, results);
        });
    },
    insertOne: function (collection: string, document: any, cb: Function) {
        let key = cache.keyByCollection(collection);
        if (cache[collection][document[key]]) {
            cb(null, false); return;
        }
        cache[collection][document[key]] = document;
        cache.inserts.push({ collection: collection, document: document });
        cb(null, true);
    },
    addLeader: function (leader: string, isRollback: boolean, cb: Function) {
        if (!cache.leaders[leader])
            cache.leaders[leader] = 1;
        if (!isRollback)
            cache.leaderChanges.push([leader, 1]);
        cache.findOne('accounts', { name: leader }, () => cb(), true);
    },
    removeLeader: function (leader: string, isRollback: boolean) {
        if (cache.leaders[leader])
            delete cache.leaders[leader];
        if (!isRollback)
            cache.leaderChanges.push([leader, 0]);
    },
    clear: function () {
        cache.changes = [];
        cache.inserts = [];
        cache.rebuild.changes = [];
        cache.rebuild.inserts = [];
        cache.leaderChanges = [];
        for (let c in cache.copy)
            cache.copy[c] = {};
    },
    writeToDisk: function (rebuild: boolean, cb: Function) {
        let executions: any[] = [];
        let insertArr = rebuild ? cache.rebuild.inserts : cache.inserts;
        for (let i = 0; i < insertArr.length; i++)
            executions.push(function (callback: any) {
                let insert = insertArr[i];
                logger.debug(`[CACHE] Starting model.create for ${insert.collection}`, insert.document);
                if (!assertModelExists(insert.collection)) {
                    const err = new Error('Invalid collection: ' + insert.collection);
                    logger.error(`[CACHE] Error in model.create for ${insert.collection}:`, err);
                    return callback(err);
                }
                const model = modelMap[insert.collection];
                model.create(insert.document, function (err: any) {
                    if (err) {
                        logger.error(`[CACHE] Error in model.create for ${insert.collection}:`, err, insert.document);
                        return callback(err);
                    }
                    logger.debug(`[CACHE] Finished model.create for ${insert.collection}`, insert.document);
                    callback();
                });
            });
        let docsToUpdate: any = {};
        for (let c in cache.copy)
            docsToUpdate[c] = {};
        let changesArr = rebuild ? cache.rebuild.changes : cache.changes;
        for (let i = 0; i < changesArr.length; i++) {
            let change = changesArr[i];
            let collection = change.collection;
            let key = change.query[cache.keyByCollection(collection)];
            docsToUpdate[collection][key] = cache[collection][key];
        }
        for (const col in docsToUpdate)
            for (const i in docsToUpdate[col])
                executions.push(function (callback: any) {
                    const docToUpdate = docsToUpdate[col][i];
                    logger.debug(`[CACHE] Starting model.replaceOne for ${col}`, docToUpdate);
                    if (!assertModelExists(col)) {
                        const err = new Error('Invalid collection: ' + col);
                        logger.error(`[CACHE] Error in model.replaceOne for ${col}:`, err);
                        return callback(err);
                    }
                    let key = cache.keyByCollection(col);
                    let newDoc = docToUpdate; // already the full document from cache
                    let query: any = {};
                    query[key] = newDoc[key];
                    const model = modelMap[col];
                    model.replaceOne(query, newDoc, { upsert: true }, function (err: any) {
                        if (err) {
                            logger.error(`[CACHE] Error in model.replaceOne for ${col}:`, err, newDoc);
                            return callback(err);
                        }
                        logger.debug(`[CACHE] Finished model.replaceOne for ${col}`, newDoc);
                        callback();
                    });
                });
        if (process.env.LEADER_STATS === '1') {
            let leaderStatsWriteOps = witnessesStats.getWriteOps();
            logger.debug('[CACHE] Adding leaderStatsWriteOps to executions', { count: leaderStatsWriteOps.length });
            for (let op of leaderStatsWriteOps) { // Changed from "in" to "of" for arrays
                // It's hard to inject logging into `op` directly here without knowing its structure.
                // If issues persist, `getWriteOps` itself needs more internal logging.
                executions.push(op);
            }
        }
        if (process.env.TX_HISTORY === '1') {
            let txHistoryWriteOps = txHistory.getWriteOps();
            logger.debug('[CACHE] Adding txHistoryWriteOps to executions', { count: txHistoryWriteOps.length });
            for (let op of txHistoryWriteOps) { // Changed from "in" to "of" for arrays
                // Similarly, direct logging injection is hard.
                executions.push(op);
            }
        }
        executions.push(function (callback: any) {
            logger.debug('[CACHE] Starting StateModel.updateOne');
            StateModel.updateOne({ _id: 0 }, { $set: { headBlock: chain.getLatestBlock()._id } }, { upsert: true })
                .then(() => {
                    logger.debug('[CACHE] Finished StateModel.updateOne successfully');
                    callback(null);
                })
                .catch((err: any) => {
                    logger.error('[CACHE] Error in StateModel.updateOne:', err);
                    callback(err);
                });
        });

        logger.debug(`[CACHE] Total operations to be executed by parallel: ${executions.length}`);
        // You can even log the collections involved if needed:
        // const collectionsInvolved = executions.map(ex => ex.toString()); // This is a bit naive, better to inspect structure
        // logger.debug('[CACHE] Execution details:', collectionsInvolved);

        if (typeof cb === 'function') {
            let timeBefore = new Date().getTime();
            parallel(executions, function (err: any, results: any) {
                let execTime = new Date().getTime() - timeBefore;
                if (!rebuild && execTime >= config.blockTime / 2)
                    logger.warn('Slow write execution: ' + executions.length + ' mongo queries took ' + execTime + 'ms');
                else
                    logger.debug(executions.length + ' mongo queries executed in ' + execTime + 'ms');
                cache.clear();
                cb(err, results);
            });
        } else {
            logger.debug(executions.length + ' mongo ops queued');
            cache.writerQueue.push((queueCallback: any) => parallel(executions, (err, results) => queueCallback(err, results)));
            cache.clear();
        }
    },
    processRebuildOps: function (cb: Function, writeToDisk: boolean) {
        for (let i in cache.inserts)
            cache.rebuild.inserts.push(cache.inserts[i]);
        for (let i in cache.changes)
            cache.rebuild.changes.push(cache.changes[i]);
        cache.inserts = [];
        cache.changes = [];
        cache.leaderChanges = [];
        for (let c in cache.copy)
            cache.copy[c] = {};
        if (writeToDisk)
            cache.writeToDisk(true, cb);
        else
            cb();
    },
    keyByCollection: function (collection: string) {
        switch (collection) {
            case 'accounts': return 'name';
            default: return '_id';
        }
    },
    warmup: function (collection: string, maxDoc: number) {
        return new Promise(async (rs, rj) => {
            if (!collection || !maxDoc || maxDoc === 0)
                return rs(null);
            switch (collection) {
                case 'accounts': {
                    try {
                        const accounts = await Account.find({}, null, { sort: { witnessVotes: -1, name: -1 }, limit: maxDoc });
                        for (let i = 0; i < accounts.length; i++)
                            cache[collection][accounts[i].name] = accounts[i];
                        rs(null);
                    } catch (err) {
                        rj(err);
                    }
                    break;
                }
                case 'tokens': {
                    try {
                        const tokens = await TokenModel.find({}, { sort: { ts: -1 }, limit: maxDoc });
                        for (let i = 0; i < tokens.length; i++)
                            cache[collection][tokens[i]._id] = tokens[i];
                        rs(null);
                    } catch (err) {
                        rj(err);
                    }
                    break;
                }
                default:
                    rj('Collection type not found');
                    break;
            }
        });
    },
    warmupLeaders: function () {
        return new Promise(async (rs) => {
            const accs = await Account.find({ witnessPublicKey: { $exists: true, $ne: '' } });
            for (const acc of accs) {
                cache.leaders[acc.name] = 1;
                if (!cache.accounts[acc.name])
                    cache.accounts[acc.name] = acc;
            }
            rs(accs.length);
        });
    }
};

export const cache = CacheStorage;

export default CacheStorage; 