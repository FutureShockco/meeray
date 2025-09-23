import { PrivateKey } from 'dsteem';

import config from '../config.js';
import logger from '../logger.js';
import { mongo } from '../mongo.js';
import settings from '../settings.js';
import SteemApiClient from '../steem/apiClient.js';

const client = new SteemApiClient();

type WithdrawDepositStatus = 'pending' | 'processing' | 'done' | 'failed';
interface WithdrawDepositData {
    _id?: any;
    to: string;
    amount: string;
    symbol: string;
    memo?: string;
    status: WithdrawDepositStatus;
    attempts: number;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
    txId: string;
}

async function transfer(to: string, amount: string, symbol: string, memo: string) {
    logger.debug(`Preparing transfer: to=${to}, amount=${amount}, symbol=${symbol}, memo=${memo}`);
    const operation = [
        'transfer',
        {
            required_auths: [settings.steemBridgeAccount],
            required_posting_auths: [],
            from: settings.steemBridgeAccount,
            to,
            amount: amount + ' ' + symbol,
            memo: memo,
        },
    ];

    try {
        logger.debug(`Broadcasting transfer from ${settings.steemBridgeAccount} to ${to} with amount: ${amount}`);
        const result = await client.sendOperations([operation], PrivateKey.fromString(settings.steemBridgeActiveKey));
        logger.debug(`Transfer successful: TX ID ${result.id}`);
        return result;
    } catch (error: any) {
        logger.error(`Error in transfer:`, error);
        if (error?.data?.stack) {
            logger.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}

async function broadcastTokenMint(mintData: { symbol: string; to: string; amount: string }) {
    const operation = [
        'custom_json',
        {
            required_auths: [settings.steemBridgeAccount],
            required_posting_auths: [],
            id: config.chainId,
            json: JSON.stringify({
                contract: 'token_mint',
                payload: mintData,
            }),
        },
    ];

    try {
        logger.debug(`Broadcasting TOKEN_MINT for ${mintData.amount} ${mintData.symbol} to ${mintData.to}`);
        const result = await client.sendOperations([operation], PrivateKey.fromString(settings.steemBridgeActiveKey));
        logger.debug(`TOKEN_MINT broadcast successful: TX ID ${result.id}`);
        return result;
    } catch (error: any) {
        logger.error(`Error in broadcastTokenMint:`, error);
        if (error?.data?.stack) {
            logger.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}

export async function enqueueWithdraw(to: string, amount: string, symbol: string, memo: string): Promise<void> {
    const db = mongo.getDb();
    const now = new Date().toISOString();
    const doc: WithdrawDepositData = {
        to,
        amount,
        symbol,
        memo,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        txId: '',
    };
    await db.collection<WithdrawDepositData>('withdrawals').insertOne(doc as any);
}

export async function enqueueDeposit(mintData: { symbol: string; to: string; amount: string }): Promise<void> {
    const db = mongo.getDb();
    const now = new Date().toISOString();
    const doc: WithdrawDepositData = {
        to: mintData.to,
        amount: mintData.amount,
        symbol: mintData.symbol,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        txId: '',
    };
    await db.collection<WithdrawDepositData>('deposits').insertOne(doc as any);
}

let workerStarted = false;
let isProcessing = false;
export function startWorker(): void {
    if (workerStarted) return;
    if (!settings.steemBridgeEnabled || !settings.steemBridgeAccount || !settings.steemBridgeActiveKey) {
        return;
    }
    workerStarted = true;
    const db = mongo.getDb();

    const loop = async () => {
        if (isProcessing) {
            setTimeout(loop, 800);
            return;
        } // keep heartbeat alive
        isProcessing = true;
        let delay = 800; // default idle delay
        try {
            // reset stale processing jobs (stuck for > 60s) - both withdrawals and deposits
            await db
                .collection('withdrawals')
                .updateMany(
                    { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 60000).toISOString() } },
                    { $set: { status: 'pending', updatedAt: new Date().toISOString() } }
                );
            await db
                .collection('deposits')
                .updateMany(
                    { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 60000).toISOString() } },
                    { $set: { status: 'pending', updatedAt: new Date().toISOString() } }
                );

            // Process withdrawals first
            const withdrawJob = await db
                .collection<WithdrawDepositData>('withdrawals')
                .findOneAndUpdate(
                    { status: 'pending' },
                    { $set: { status: 'processing', updatedAt: new Date().toISOString() } },
                    { returnDocument: 'after' as any, sort: { createdAt: 1 } }
                );
            const withdrawDoc: any = (withdrawJob as any)?.value ?? withdrawJob;
            const withdrawJobDoc: WithdrawDepositData | null =
                withdrawDoc && (withdrawDoc as any)._id ? (withdrawDoc as WithdrawDepositData) : null;

            if (withdrawJobDoc) {
                delay = 200; // have backlog, poll a bit faster
                try {
                    const tx = await transfer(
                        withdrawJobDoc.to,
                        withdrawJobDoc.amount,
                        withdrawJobDoc.symbol,
                        withdrawJobDoc.memo ? withdrawJobDoc.memo : ''
                    );
                    await db
                        .collection('withdrawals')
                        .updateOne(
                            { _id: (withdrawJobDoc as any)._id },
                            { $set: { status: 'done', updatedAt: new Date().toISOString(), txId: tx.id } }
                        );
                } catch (err: any) {
                    await db.collection('withdrawals').updateOne(
                        { _id: (withdrawJobDoc as any)._id },
                        {
                            $set: {
                                status: 'failed',
                                lastError: String(err?.message || err),
                                updatedAt: new Date().toISOString(),
                            },
                            $inc: { attempts: 1 },
                        }
                    );
                }
            } else {
                // No withdrawals, check for deposits
                const depositJob = await db
                    .collection<WithdrawDepositData>('deposits')
                    .findOneAndUpdate(
                        { status: 'pending' },
                        { $set: { status: 'processing', updatedAt: new Date().toISOString() } },
                        { returnDocument: 'after' as any, sort: { createdAt: 1 } }
                    );
                const depositDoc: any = (depositJob as any)?.value ?? depositJob;
                const depositJobDoc: WithdrawDepositData | null =
                    depositDoc && (depositDoc as any)._id ? (depositDoc as WithdrawDepositData) : null;

                if (depositJobDoc) {
                    delay = 200; // have backlog, poll a bit faster
                    try {
                        const mintData = {
                            symbol: depositJobDoc.symbol,
                            to: depositJobDoc.to,
                            amount: depositJobDoc.amount,
                        };
                        const tx = await broadcastTokenMint(mintData);
                        await db
                            .collection('deposits')
                            .updateOne(
                                { _id: (depositJobDoc as any)._id },
                                { $set: { status: 'done', updatedAt: new Date().toISOString(), txId: tx.id } }
                            );
                    } catch (err: any) {
                        await db.collection('deposits').updateOne(
                            { _id: (depositJobDoc as any)._id },
                            {
                                $set: {
                                    status: 'failed',
                                    lastError: String(err?.message || err),
                                    updatedAt: new Date().toISOString(),
                                },
                                $inc: { attempts: 1 },
                            }
                        );
                    }
                }
            }
        } catch {
            // ignore and continue
        } finally {
            isProcessing = false;
            setTimeout(loop, delay);
        }
    };
    setTimeout(loop, 200);
}

export const steemBridge = { transfer, enqueueWithdraw, enqueueDeposit, startWorker };
