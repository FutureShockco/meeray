import cloneDeep from 'clone-deep'

interface Transaction {
  hash: string;
  sender?: string;
  data?: {
    target?: string;
    receiver?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface Block {
  _id: number;
  txs: Transaction[];
  [key: string]: any;
}

declare const db: any;

const txHistory = {
  indexQueue: [] as Transaction[],
  accounts: process.env.TX_HISTORY_ACCOUNTS ? process.env.TX_HISTORY_ACCOUNTS.split(',') : [],
  // Processes a block and indexes transactions for specified accounts (witness-aware)
  processBlock: (block: Block) => {
    if (process.env.TX_HISTORY !== '1') return;
    for (const t of block.txs) {
      if (
        txHistory.accounts.length === 0 ||
        (typeof t.sender === 'string' && txHistory.accounts.includes(t.sender)) ||
        (typeof t.data?.target === 'string' && txHistory.accounts.includes(t.data.target)) ||
        (typeof t.data?.receiver === 'string' && txHistory.accounts.includes(t.data.receiver))) {
        const newTxItm = cloneDeep(t);
        newTxItm._id = newTxItm.hash;
        newTxItm.includedInBlock = block._id;
        // In a witness system, this can be extended to include witness info if needed
        txHistory.indexQueue.push(newTxItm);
      }
    }
  },
  getWriteOps: () => {
    if (process.env.TX_HISTORY !== '1') return [];
    const ops: Array<(cb: (err: any, res?: any) => void) => void> = [];
    for (const newTx of txHistory.indexQueue) {
      ops.push((cb) => db.collection('txs').insertOne(newTx, cb));
    }
    txHistory.indexQueue = [];
    return ops;
  },
};

export default txHistory; 