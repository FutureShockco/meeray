import logger from './logger.js';
import mongo from './mongo.js';
import { IWitnessStats } from './models/witnessStats.js';

// @ts-ignore
const db = { collection: () => ({ updateOne: () => {}, find: () => ({ toArray: () => {} }) }) } as any; // TODO: Replace with actual db/mongo implementation

interface IWitnessIndexer {
  witnesses: Record<string, Partial<IWitnessStats>>;
  updates: { witnesses: string[] };
  processBlock: (block: any) => void;
  getWriteOps: () => ((cb: (err: any, res?: any) => void) => void)[];
  loadIndex: () => Promise<void>;
}

const indexer: IWitnessIndexer = {
  witnesses: {
    "echelon-node1": {
      sinceTs: 0,
      sinceBlock: 0,
      produced: 1,
      missed: 0,
      voters: 1, // genesis
      last: 0,
    },
  },
  updates: {
    witnesses: [],
  },
  processBlock: (block: any) => {
    if (process.env.WITNESS_STATS !== '1') return;
    if (!block) throw new Error('cannot process undefined block');

    // Setup new witness accounts
    if (!indexer.witnesses[block.witness])
      indexer.witnesses[block.witness] = {
        produced: 0,
        missed: 0,
        voters: 0,
        last: 0,
      };
    if (block.missedBy && !indexer.witnesses[block.missedBy])
      indexer.witnesses[block.missedBy] = {
        produced: 0,
        missed: 0,
        voters: 0,
        last: 0,
      };

    // Increment produced/missed
    indexer.witnesses[block.witness]!.produced! += 1;
    indexer.witnesses[block.witness]!.last = block._id;
    if (block.missedBy) indexer.witnesses[block.missedBy]!.missed! += 1;

    // Record first time producers whenever applicable
    if (!indexer.witnesses[block.witness]!.sinceTs) indexer.witnesses[block.witness]!.sinceTs = block.timestamp;
    if (!indexer.witnesses[block.witness]!.sinceBlock) indexer.witnesses[block.witness]!.sinceBlock = block._id;

    // Witness updates
    if (!indexer.updates.witnesses.includes(block.witness))
      indexer.updates.witnesses.push(block.witness);
    if (block.missedBy && !indexer.updates.witnesses.includes(block.missedBy))
      indexer.updates.witnesses.push(block.missedBy);

    // Look for approves/disapproves in tx
    for (let i = 0; i < block.txs.length; i++) {
      if (block.txs[i].type === 1) {
        // APPROVE_STEEM_ACCOUNT
        if (!indexer.witnesses[block.txs[i].data.target])
          indexer.witnesses[block.txs[i].data.target] = {
            produced: 0,
            missed: 0,
            voters: 0,
            last: 0,
          };
        indexer.witnesses[block.txs[i].data.target]!.voters! += 1;
        if (!indexer.updates.witnesses.includes(block.txs[i].data.target))
          indexer.updates.witnesses.push(block.txs[i].data.target);
      } else if (block.txs[i].type === 2) {
        // DISAPPROVE_STEEM_ACCOUNT
        if (!indexer.witnesses[block.txs[i].data.target])
          indexer.witnesses[block.txs[i].data.target] = {
            produced: 0,
            missed: 0,
            voters: 0,
            last: 0,
          };
        indexer.witnesses[block.txs[i].data.target]!.voters! -= 1;
        if (!indexer.updates.witnesses.includes(block.txs[i].data.target))
          indexer.updates.witnesses.push(block.txs[i].data.target);
      } else if (block.txs[i].type === 18 && !indexer.witnesses[block.txs[i].sender]) {
        // ENABLE_NODE
        indexer.witnesses[block.txs[i].sender] = {
          produced: 0,
          missed: 0,
          voters: 0,
          last: 0,
        };
        if (!indexer.updates.witnesses.includes(block.txs[i].sender))
          indexer.updates.witnesses.push(block.txs[i].sender);
      }
    }
  },
  getWriteOps: () => {
    if (process.env.WITNESS_STATS !== '1') return [];
    let ops: ((cb: (err: any, res?: any) => void) => void)[] = [];
    for (let accKey in indexer.updates.witnesses) {
      const updatedWitnessName = indexer.updates.witnesses[accKey];
      ops.push((cb) => mongo.getDb().collection<IWitnessStats>('witnessStats').updateOne(
        { _id: updatedWitnessName },
        { $set: indexer.witnesses[updatedWitnessName] },
        { upsert: true },
      ).then(() => cb(null, true)).catch(cb)
      );
    }
    indexer.updates.witnesses = [];
    return ops;
  },
  loadIndex: async () => {
    if (process.env.WITNESS_STATS !== '1') return;
    try {
      const db = mongo.getDb();
      const witnesses = await db.collection<IWitnessStats>('witnessStats').find({}).toArray();
      for (const witness of witnesses) {
        const witnessName = witness._id as string;
        indexer.witnesses[witnessName] = { ...witness };
        delete indexer.witnesses[witnessName]._id;
      }
    } catch (e) {
      logger.error('Failed to load witness stats:', e);
      throw e;
    }
  },
};

export const witnessesStats = indexer;
export default witnessesStats; 