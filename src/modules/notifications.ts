import config from '../config.js';
import { NotificationModel } from '../models/notification.js';
import { TransactionType } from '../transactions/types.js';
import chain from '../chain.js';
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
        await NotificationModel.deleteMany({
            ts: { $lt: threshold }
        });
    },
    processTx: async (tx: any, ts: number) => {
        let notif: any = {};
        switch (tx.type) {
            case TransactionType.CREATE_TOKEN:
                notif = {
                    u: tx.data.owner,
                    tx: tx,
                    ts: ts
                };
                await NotificationModel.create(notif);
                break;
            case TransactionType.TRANSFER_TOKEN:
                notif = {
                    u: tx.data.receiver,
                    tx: tx,
                    ts: ts
                };
                await NotificationModel.create(notif);
                break;
            default:
                break;
        }
    }
};

export default notifications; 