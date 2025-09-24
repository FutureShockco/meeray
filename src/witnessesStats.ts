import logger from './logger.js';
import mongo from './mongo.js';

interface IWitnessStats {
    _id?: string;
    sinceTs?: number;
    sinceBlock?: number;
    produced?: number;
    missed?: number;
    voters?: number;
    last?: number;
}

interface IWitnessIndexer {
    witnesses: Record<string, Partial<IWitnessStats>>;
    updates: { witnesses: string[] };
    processBlock: (block: any) => void;
    getWriteOps: () => ((cb: (err: any, res?: any) => void) => void)[];
    loadIndex: () => Promise<void>;
}

const indexer: IWitnessIndexer = {
    witnesses: {
        'meeray-node1': {
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

        const witness = indexer.witnesses[block.witness];
        if (witness) {
            witness.produced = (witness.produced || 0) + 1;
            witness.last = block._id;
        }

        if (block.missedBy) {
            const missedWitness = indexer.witnesses[block.missedBy];
            if (missedWitness) {
                missedWitness.missed = (missedWitness.missed || 0) + 1;
            }
        }

        if (witness) {
            if (!witness.sinceTs) witness.sinceTs = block.timestamp;
            if (!witness.sinceBlock) witness.sinceBlock = block._id;
        }

        if (!indexer.updates.witnesses.includes(block.witness)) indexer.updates.witnesses.push(block.witness);
        if (block.missedBy && !indexer.updates.witnesses.includes(block.missedBy)) indexer.updates.witnesses.push(block.missedBy);

        for (let i = 0; i < block.txs.length; i++) {
            if (block.txs[i].type === 1) {
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
                indexer.witnesses[block.txs[i].sender] = {
                    produced: 0,
                    missed: 0,
                    voters: 0,
                    last: 0,
                };
                if (!indexer.updates.witnesses.includes(block.txs[i].sender)) indexer.updates.witnesses.push(block.txs[i].sender);
            }
        }
    },
    getWriteOps: () => {
        if (process.env.WITNESS_STATS !== '1') return [];
        const ops: ((cb: (err: any, res?: any) => void) => void)[] = [];
        for (const accKey in indexer.updates.witnesses) {
            const updatedWitnessName = indexer.updates.witnesses[accKey];
            ops.push(cb =>
                mongo
                    .getDb()
                    .collection<IWitnessStats>('witnessStats')
                    .updateOne({ _id: updatedWitnessName }, { $set: indexer.witnesses[updatedWitnessName] }, { upsert: true })
                    .then(() => cb(null, true))
                    .catch(cb)
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
