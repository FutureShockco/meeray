import settings from '../settings.js';
import SteemApiClient from '../steem/apiClient.js';
import { PrivateKey } from 'dsteem';
import { mongo } from '../mongo.js';
const client = new SteemApiClient();


async function transfer(to: string, amount: string, symbol: string, memo: string) {
    console.log(to, amount, symbol, memo);
    const operation = ['transfer', {
        required_auths: [settings.steemBridgeAccount],
        required_posting_auths: [],
        from: settings.steemBridgeAccount,
        to,
        amount: amount + ' ' + symbol,
        memo: memo
    }];

    try {
        console.log(`Broadcasting transfer from ${settings.steemBridgeAccount} to ${to} with amount: ${amount}`);
        const result = await client.sendOperations([operation], PrivateKey.fromString(settings.steemBridgeActiveKey));
        console.log(`Transfer successful: TX ID ${result.id}`);
        return result;
    } catch (error: any) {
        console.error(`Error in transfer:`, error);
        if (error?.data?.stack) {
            console.error('dsteem error data:', error.data.stack);
        }
        throw error;
    }
}



// --- Async withdraw queue ---
type WithdrawStatus = 'pending' | 'processing' | 'done' | 'failed';
interface WithdrawJobDoc {
    _id?: any;
    to: string;
    amount: string; // formatted decimal string for Steem layer
    symbol: string; // e.g., TESTS or SBD
    memo: string;
    status: WithdrawStatus;
    attempts: number;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
    txId: string;
}

export async function enqueueWithdraw(to: string, amount: string, symbol: string, memo: string): Promise<void> {
    const db = mongo.getDb();
    const now = new Date().toISOString();
    const doc: WithdrawJobDoc = {
        to,
        amount,
        symbol,
        memo,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        txId: ''
    };
    await db.collection<WithdrawJobDoc>('withdrawals').insertOne(doc as any);
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
        if (isProcessing) { setTimeout(loop, 400); return; } // keep heartbeat alive
        isProcessing = true;
        let delay = 800; // default idle delay
        try {
            // reset stale processing jobs (stuck for > 60s)
            await db.collection('withdrawals').updateMany(
                { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 60000).toISOString() } },
                { $set: { status: 'pending', updatedAt: new Date().toISOString() } }
            );
            const job = await db.collection<WithdrawJobDoc>('withdrawals').findOneAndUpdate(
                { status: 'pending' },
                { $set: { status: 'processing', updatedAt: new Date().toISOString() } },
                { returnDocument: 'after' as any, sort: { createdAt: 1 } }
            );
            const maybeDoc: any = (job as any)?.value ?? job;
            const doc: WithdrawJobDoc | null = (maybeDoc && (maybeDoc as any)._id) ? (maybeDoc as WithdrawJobDoc) : null;
            if (doc) {
                delay = 200; // have backlog, poll a bit faster
                try {
                    const tx = await transfer(doc.to, doc.amount, doc.symbol, doc.memo);
                    await db.collection('withdrawals').updateOne(
                        { _id: (doc as any)._id },
                        { $set: { status: 'done', updatedAt: new Date().toISOString(), txId: tx.id } }
                    );
                } catch (err: any) {
                    await db.collection('withdrawals').updateOne(
                        { _id: (doc as any)._id },
                        { $set: { status: 'failed', lastError: String(err?.message || err), updatedAt: new Date().toISOString() }, $inc: { attempts: 1 } }
                    );
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

export const steemBridge = { transfer, enqueueWithdraw, startWorker };