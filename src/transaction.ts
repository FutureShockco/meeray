import CryptoJS from 'crypto-js';
import { EventEmitter } from 'events';
import { Transaction as TransactionInterface } from './transactions/index.js';
import logr from './logger.js';
import validation from './validation/index.js';
import config from './config.js';
import { TransactionType } from './transactions/types.js';
import chain from './chain.js';
import cache from './cache.js';
import { transactionHandlers } from './transactions/index.js';
import { upsertAccountsReferencedInTx } from './account.js';
import p2p from './p2p.js';
import cloneDeep from 'clone-deep';
import bson from 'bson';
import { isValidSignature } from './crypto.js';
// Constants
const MAX_MEMPOOL_SIZE = parseInt(process.env.MEMPOOL_SIZE || '2000', 10);


type ValidationCallback = (isValid: boolean, error?: string) => void;


type ExecutionCallback = (executed: boolean, distributed?: number) => void;


interface TransactionModule {
    pool: TransactionInterface[];
    eventConfirmation: EventEmitter;
    createHash: (tx: TransactionInterface) => string;
    addToPool: (txs: TransactionInterface[]) => void;
    isPoolFull: () => boolean;
    removeFromPool: (txs: TransactionInterface[]) => void;
    cleanPool: () => void;
    isInPool: (tx: TransactionInterface) => boolean;
    isPublished: (tx: TransactionInterface) => boolean | undefined;
    isValid: (tx: TransactionInterface, ts: number, cb: ValidationCallback) => Promise<void>;
    isValidTxData: (tx: TransactionInterface, ts: number, legitUser: string, cb: ValidationCallback) => void;
    execute: (tx: TransactionInterface, ts: number, cb: ExecutionCallback) => void;
    updateIntsAndNodeApprPromise: (account: any, ts: number, change: number) => Promise<boolean>;
    adjustNodeAppr: (acc: any, newCoins: number, cb: (success: boolean) => void) => void;
}

const transaction: TransactionModule = {
    pool: [], // The pool holds temporary txs that haven't been published on chain yet
    eventConfirmation: new EventEmitter(),
    createHash: (tx: TransactionInterface): string => {
        return CryptoJS.SHA256(JSON.stringify({
            type: tx.type,
            data: tx.data,
            sender: tx.sender,
            ts: tx.ts,
            ref: (tx as any).ref // Handle optional ref field
        })).toString();
    },


    addToPool: async (txs: TransactionInterface[]): Promise<void> => {
        if (transaction.isPoolFull()) {
            logr.warn('Transaction pool is full, not adding transactions');
            return;
        }
        let added = 0;
        for (let y = 0; y < txs.length; y++) {
            let exists = false;
            for (let i = 0; i < transaction.pool.length; i++) {
                if (transaction.pool[i].hash === txs[y].hash) {
                    exists = true;
                    logr.debug(`Transaction ${txs[y].hash} already exists in pool, skipping`);
                    break;
                }
            }

            if (!exists) {
                transaction.pool.push(txs[y]);
                added++;
                logr.debug(`Added transaction to pool: type=${txs[y].type}, sender=${txs[y].sender}, hash=${txs[y].hash}`);

            }
        }

        logr.info(`Added ${added} new transactions to pool (new size: ${transaction.pool.length})`);
    },


    isPoolFull: (): boolean => {
        if (transaction.pool.length >= MAX_MEMPOOL_SIZE) {
            logr.warn(`Mempool is full (${transaction.pool.length}/${MAX_MEMPOOL_SIZE} txs), ignoring tx`);
            return true;
        }
        return false;
    },

    removeFromPool: (txs: TransactionInterface[]): void => {
        for (let y = 0; y < txs.length; y++) {
            for (let i = 0; i < transaction.pool.length; i++) {
                if (transaction.pool[i].hash === txs[y].hash) {
                    transaction.pool.splice(i, 1);
                    break;
                }
            }
        }
    },

    cleanPool: (): void => {
        for (let i = 0; i < transaction.pool.length; i++) {
            if (transaction.pool[i] && transaction.pool[i].ts! + config.read(0).txExpirationTime < new Date().getTime()) {
                transaction.pool.splice(i, 1);
                i--;
            }
        }
    },

    isInPool: (tx: TransactionInterface): boolean => {
        let isInPool = false;
        for (let i = 0; i < transaction.pool.length; i++) {
            if (transaction.pool[i].hash === tx.hash) {
                isInPool = true;
                break;
            }
        }
        return isInPool;
    },

    isPublished: (tx: TransactionInterface): boolean | undefined => {
        if (!tx.hash) return undefined;
        if (chain.recentTxs[tx.hash]) {
            return true;
        }
        return false;
    },

    isValid: async (tx: TransactionInterface, ts: number, cb: ValidationCallback): Promise<void> => {
        if (!tx) {
            cb(false, 'no transaction');
            return;
        }
        // Generic validations (already present)
        if (!validation.integer(tx.type, true, false) || !(tx.type in TransactionType)) { // Added check if type is in enum
            cb(false, 'invalid tx type');
            return;
        }
        if (!tx.data || typeof tx.data !== 'object') {
            cb(false, 'invalid tx data');
            return;
        }
        if (!validation.string(tx.sender)) {
            cb(false, 'invalid tx sender');
            return;
        }
        if (!validation.integer(tx.ts, false, false)) {
            cb(false, 'invalid tx ts');
            return;
        }
        if (!tx.hash || typeof tx.hash !== 'string') {
            cb(false, 'invalid tx hash'); return
        }

        if (transaction.isPublished(tx)) {
            cb(false, 'transaction already in chain'); return
        }
        // RESTORED: upsertAccountsReferencedInTx call here
        try {
            await upsertAccountsReferencedInTx(tx);
        } catch (error) {
            logr.error(`Error upserting account referenced in tx ${tx.hash} during validation:`, error);
            // If account upsertion fails here, the transaction should be considered invalid.
            cb(false, `Failed to upsert accounts: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        let newTx = cloneDeep(tx)
        delete newTx.signature
        delete newTx.hash


        transaction.isValidTxData(tx, ts, tx.sender, function (isValid, error) {
            cb(isValid, error)
        })
    },

    isValidTxData: (tx: TransactionInterface, ts: number, legitUser: string, cb: ValidationCallback): void => {
        const handler = transactionHandlers[tx.type as TransactionType];
        if (handler)
            handler.validate(tx.data, tx.sender)
                .then((isValidSpecific: boolean) => {
                    if (!isValidSpecific) {
                        cb(false, `Specific validation failed for type ${TransactionType[tx.type as TransactionType]}`); // Error = true
                    } else {
                        cb(true, undefined); // Error = false (valid)
                    }
                })
                .catch((error: Error) => {
                    logr.error(`Error during specific transaction validation (isValidTxData) for type ${tx.type}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    cb(false, `Validation error for ${TransactionType[tx.type as TransactionType]}: ${errorMessage}`); // Error = true
                });
    },

    execute: (tx: TransactionInterface, ts: number, cb: ExecutionCallback): void => {
        const handler = transactionHandlers[tx.type as TransactionType];
        if (handler)
            handler.process(tx.data, tx.sender)
                .then((success: boolean) => {
                    if (!success) {
                        logr.warn(`Execution failed for type ${TransactionType[tx.type as TransactionType]} by sender ${tx.sender}`);
                        cb(false, undefined);
                    } else {
                        cb(true, undefined); // Executed
                    }
                })
                .catch((error: Error) => {
                    logr.error(`Error during transaction execution for type ${tx.type}:`, error);
                    cb(false, undefined);
                });
    },

    updateIntsAndNodeApprPromise: function (account: any, ts: number, change: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            transaction.adjustNodeAppr(account, change, () => resolve(true));
        });
    },

    adjustNodeAppr: (acc: any, newCoins: number, cb: (success: boolean) => void): void => {
        if (!acc.votedWitnesses || acc.votedWitnesses.length === 0 || !newCoins || newCoins === 0) {
            cb(true);
            return;
        }

        const balance_before = acc.tokens?.ECH || 0;
        const witness_share_before = acc.votedWitnesses.length > 0 ? Math.floor(balance_before / acc.votedWitnesses.length) : 0;

        const balance_after = balance_before + newCoins;
        // Ensure balance_after is not negative if newCoins could be negative, though rewards are positive.
        // const new_balance_non_negative = Math.max(0, balance_after); 
        // For now, assuming newCoins is always positive as it's from 'reward'.

        const witness_share_after = acc.votedWitnesses.length > 0 ? Math.floor(balance_after / acc.votedWitnesses.length) : 0;

        const diff_per_witness = witness_share_after - witness_share_before;

        if (diff_per_witness === 0) { // If the share difference is zero, no update needed
            cb(true);
            return;
        }

        const witnesses_to_update: string[] = [...acc.votedWitnesses]; // Make a copy

        logr.debug(`NodeAppr Update for voter ${acc.name}: newCoins=${newCoins}, balance_before=${balance_before}, balance_after=${balance_after}, share_before=${witness_share_before}, share_after=${witness_share_after}, diff_per_witness=${diff_per_witness}, witnesses_count=${witnesses_to_update.length}`);

        if (witnesses_to_update.length === 0) { // Should be caught by initial check, but good to have.
            cb(true);
            return;
        }

        cache.updateMany(
            'accounts',
            { name: { $in: witnesses_to_update } },
            { $inc: { totalVoteWeight: diff_per_witness } }, // This will be applied to each witness in the $in list
            function (err: Error | null) {
                if (err) {
                    // It's generally better to log and callback with error than to throw,
                    // unless the calling infrastructure expects throws.
                    logr.error(`[adjustNodeAppr] Error in cache.updateMany for ${acc.name}'s voted witnesses:`, err);
                    cb(false); // Indicate failure
                    return;
                }
                cb(true);
            }
        );
    }
};


export default transaction;
