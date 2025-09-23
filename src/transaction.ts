import cloneDeep from 'clone-deep';
import CryptoJS from 'crypto-js';
import { EventEmitter } from 'events';

import chain from './chain.js';
import config from './config.js';
import logr from './logger.js';
import { Transaction as TransactionInterface, transactionHandlers } from './transactions/index.js';
import { TransactionType } from './transactions/types.js';
import validation from './validation/index.js';

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
}

const transaction: TransactionModule = {
    pool: [],
    eventConfirmation: new EventEmitter(),
    createHash: (tx: TransactionInterface): string => {
        return CryptoJS.SHA256(
            JSON.stringify({
                type: tx.type,
                data: tx.data,
                sender: tx.sender,
                ts: tx.ts,
                ref: (tx as any).ref,
            })
        ).toString();
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

        if (!validation.integer(tx.type, true, false) || !(tx.type in TransactionType)) {
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
            cb(false, 'invalid tx hash');
            return;
        }

        if (transaction.isPublished(tx)) {
            cb(false, 'transaction already in chain');
            return;
        }
        const newTx = cloneDeep(tx);
        delete newTx.signature;
        delete newTx.hash;

        transaction.isValidTxData(tx, ts, tx.sender, function (isValid, error) {
            cb(isValid, error);
        });
    },

    isValidTxData: (tx: TransactionInterface, ts: number, legitUser: string, cb: ValidationCallback): void => {
        const handler = transactionHandlers[tx.type as TransactionType];
        if (handler && typeof handler.validate === 'function') {
            handler
                .validate(tx.data, tx.sender, tx.id, tx.ts)
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
        } else {
            // If no handler or validate function is not found, consider it invalid and call the callback
            const reason = handler
                ? `Validate function missing for handler type ${tx.type}`
                : `Unknown transaction type handler for type ${tx.type}`;
            logr.warn(`[transaction.isValidTxData] ${reason}`);
            cb(false, reason);
        }
    },

    execute: (tx: TransactionInterface, ts: number, cb: ExecutionCallback): void => {
        const handler = transactionHandlers[tx.type as TransactionType];
        if (handler)
            handler
                .process(tx.data, tx.sender, tx.hash, tx.ts || ts)
                .then((success: boolean) => {
                    if (!success) {
                        logr.warn(
                            `Execution failed for type ${TransactionType[tx.type as TransactionType]} by sender ${tx.sender}`
                        );
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
};

export default transaction;
