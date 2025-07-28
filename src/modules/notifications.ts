import config from '../config.js';
import { TransactionType } from '../transactions/types.js';
import { chain } from '../chain.js';
import mongo from '../mongo.js';
const isEnabled = process.env.NOTIFICATIONS === 'true' || false;

export const notifications = {
    processBlock: async (block: any) => {
        if (!isEnabled || (chain.restoredBlocks && chain.getLatestBlock()._id + config.notifPurge * config.notifPurgeAfter < chain.restoredBlocks)) return;

        if (block._id % config.notifPurge === 0)
            await notifications.purgeOld(block);

        for (let i = 0; i < block.txs.length; i++)
            await notifications.processTx(block.txs[i], block.timestamp);
    },
    purgeOld: async (block: any) => {
        let threshold = block.timestamp - config.notifPurge * config.notifPurgeAfter * config.blockTime;
        await mongo.getDb().collection('notifications').deleteMany({
            ts: { $lt: threshold }
        });
    },
    processTx: async (tx: any, ts: number) => {
        let notif: any = {};
        switch (tx.type) {
            case TransactionType.TOKEN_CREATE:
                const tokenCreateData = tx.data;
                if (tokenCreateData.issuer) {
                notif = {
                        u: tokenCreateData.issuer,
                    tx: tx,
                    ts: ts
                };
                await mongo.getDb().collection('notifications').insertOne(notif);
                }
                break;
            case TransactionType.TOKEN_TRANSFER:
                const tokenTransferData = tx.data;
                notif = {
                    u: tokenTransferData.receiver,
                    tx: tx,
                    ts: ts
                };
                await mongo.getDb().collection('notifications').insertOne(notif);
                break;
            default:
                break;
        }
    }
};

export default notifications; 