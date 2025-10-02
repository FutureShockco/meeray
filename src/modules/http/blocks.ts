import express, { Request, RequestHandler, Response } from 'express';

import { chain } from '../../chain.js';
import logger from '../../logger.js';
import { mongo } from '../../mongo.js';
import { transformTransactionData } from '../../utils/http.js';

const router = express.Router();

/**
 * Extracts pagination parameters from request query
 * @param req Express request object
 * @returns Object containing limit, skip, and page values
 */
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

/**
 * Transforms block data for API response
 * @param block Raw block data from database
 * @returns Transformed block data with proper field names and transaction data
 */
const transformBlockData = (block: any): any => {
    if (!block) return block;
    const { _id, txs, ...restOfBlock } = block;
    return {
        ...restOfBlock,
        id: _id.toString(),
        txs: txs
            ? txs.map((tx: any) => {
                  const { _id: txId, data, ...restOfTx } = tx;
                  const transformedTx: any = { ...restOfTx, data: transformTransactionData(data) };
                  if (txId) {
                      transformedTx.id = txId.toString();
                  }
                  return transformedTx;
              })
            : [],
    };
};

/**
 * @api {get} /blocks Get All Blocks
 * @apiName GetBlocks
 * @apiGroup Blocks
 * @apiDescription Retrieves a paginated list of blocks with optional filtering
 *
 * @apiQuery {Number} [limit=10] Maximum number of blocks to return
 * @apiQuery {Number} [offset=0] Number of blocks to skip (for pagination)
 * @apiQuery {Number} [hasTransactionType] Filter blocks containing transactions of specific type
 * @apiQuery {Number} [minTimestamp] Filter blocks with timestamp >= this value
 * @apiQuery {Number} [maxTimestamp] Filter blocks with timestamp <= this value
 * @apiQuery {String="asc","desc"} [sortDirection="desc"] Sort direction
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Object[]} data Array of block objects
 * @apiSuccess {String} data.id Block identifier
 * @apiSuccess {Number} data.height Block height
 * @apiSuccess {String} data.hash Block hash
 * @apiSuccess {String} data.previousHash Previous block hash
 * @apiSuccess {Number} data.timestamp Unix timestamp in milliseconds
 * @apiSuccess {String} data.witness Account that produced this block
 * @apiSuccess {Object[]} data.txs Array of transactions in this block
 * @apiSuccess {Number} total Total number of blocks matching query
 * @apiSuccess {Number} limit Number of blocks returned
 * @apiSuccess {Number} skip Number of blocks skipped
 *
 * @apiError {String} error Error message
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks?limit=20&hasTransactionType=29"
 */
router.get('/', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        const query: any = {};
        if (req.query.hasTransactionType) {
            query['transactions.type'] = parseInt(req.query.hasTransactionType as string);
        }
        if (req.query.minTimestamp) {
            query.timestamp = { $gte: parseInt(req.query.minTimestamp as string) };
        }
        if (req.query.maxTimestamp) {
            if (!query.timestamp) query.timestamp = {};
            query.timestamp.$lte = parseInt(req.query.maxTimestamp as string);
        }
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const blocksFromDB = await mongo.getDb().collection('blocks').find(query).sort({ height: sortDirection }).limit(limit).skip(skip).toArray();
        const total = await mongo.getDb().collection('blocks').countDocuments(query);
        const blocks = blocksFromDB.map(transformBlockData);
        res.json({
            success: true,
            data: blocks,
            total,
            limit,
            skip,
        });
    } catch (err) {
        logger.error('Error fetching blocks:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /blocks/latest Get Latest Block
 * @apiName GetLatestBlock
 * @apiGroup Blocks
 * @apiDescription Retrieves the most recent block from the blockchain
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Object} block Latest block object
 * @apiSuccess {String} block.id Block identifier
 * @apiSuccess {Number} block.height Block height
 * @apiSuccess {String} block.hash Block hash
 * @apiSuccess {String} block.previousHash Previous block hash
 * @apiSuccess {Number} block.timestamp Unix timestamp in milliseconds
 * @apiSuccess {String} block.witness Account that produced this block
 * @apiSuccess {Object[]} block.transactions Array of transactions in this block
 *
 * @apiError {String} error Error message
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks/latest"
 */
router.get('/latest', ((_req: Request, res: Response) => {
    try {
        const latestBlockFromChain = chain.getLatestBlock?.();
        if (!latestBlockFromChain) {
            return res.status(404).json({ error: 'No blocks found' });
        }
        const { transactions, _id, ...restOfBlock } = latestBlockFromChain;
        const transformedBlock: any = { ...restOfBlock };
        if (_id) {
            transformedBlock.id = _id.toString();
        }
        if (transactions && Array.isArray(transactions)) {
            transformedBlock.transactions = transactions.map((tx: any) => {
                const { data, ...restOfTx } = tx;
                return {
                    ...restOfTx,
                    data: transformTransactionData(data),
                };
            });
        }
        res.json({ success: true, block: transformedBlock });
    } catch (err) {
        logger.error('Error fetching latest block:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /blocks/height/:height Get Block by Height
 * @apiName GetBlockByHeight
 * @apiGroup Blocks
 * @apiDescription Retrieves a specific block by its height (block number)
 *
 * @apiParam {Number} height Block height to retrieve
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Object} block Block object
 * @apiSuccess {String} block.id Block identifier
 * @apiSuccess {Number} block.height Block height
 * @apiSuccess {String} block.hash Block hash
 * @apiSuccess {String} block.previousHash Previous block hash
 * @apiSuccess {Number} block.timestamp Unix timestamp in milliseconds
 * @apiSuccess {String} block.witness Account that produced this block
 * @apiSuccess {Object[]} block.txs Array of transactions in this block
 *
 * @apiError {String} error Error message
 * @apiError (400) {String} error Invalid block height. Must be a number.
 * @apiError (404) {String} error Block with height {height} not found
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks/height/1000"
 */
router.get('/height/:height', (async (req: Request, res: Response) => {
    try {
        const height = parseInt(req.params.height);
        if (isNaN(height)) {
            return res.status(400).json({ error: 'Invalid block height. Must be a number.' });
        }
        const blockFromDB = await mongo.getDb().collection('blocks').findOne({ height });
        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        const transformedBlock = transformBlockData(blockFromDB);
        res.json({ success: true, block: transformedBlock });
    } catch (err) {
        logger.error(`Error fetching block by height ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /blocks/hash/:hash Get Block by Hash
 * @apiName GetBlockByHash
 * @apiGroup Blocks
 * @apiDescription Retrieves a specific block by its hash
 *
 * @apiParam {String} hash Block hash to retrieve
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Object} block Block object
 * @apiSuccess {String} block.id Block identifier
 * @apiSuccess {Number} block.height Block height
 * @apiSuccess {String} block.hash Block hash
 * @apiSuccess {String} block.previousHash Previous block hash
 * @apiSuccess {Number} block.timestamp Unix timestamp in milliseconds
 * @apiSuccess {String} block.witness Account that produced this block
 * @apiSuccess {Object[]} block.txs Array of transactions in this block
 *
 * @apiError {String} error Error message
 * @apiError (404) {String} error Block with hash {hash} not found
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks/hash/0xabc123def456..."
 */
router.get('/hash/:hash', (async (req: Request, res: Response) => {
    try {
        const hash = req.params.hash;

        const blockFromDB = await mongo.getDb().collection('blocks').findOne({ hash });

        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with hash ${hash} not found` });
        }
        const transformedBlock = transformBlockData(blockFromDB);
        res.json({ success: true, block: transformedBlock });
    } catch (err) {
        logger.error(`Error fetching block by hash ${req.params.hash}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /blocks/:height/transactions Get Block Transactions
 * @apiName GetBlockTransactions
 * @apiGroup Blocks
 * @apiDescription Retrieves all transactions from a specific block by height
 *
 * @apiParam {Number} height Block height to get transactions from
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Number} blockHeight Block height
 * @apiSuccess {String} blockId Block identifier
 * @apiSuccess {Object[]} transactions Array of transaction objects
 * @apiSuccess {Number} transactions.type Transaction type
 * @apiSuccess {String} transactions.sender Account that sent the transaction
 * @apiSuccess {Object} transactions.data Transaction-specific data
 * @apiSuccess {Number} transactions.timestamp Unix timestamp in milliseconds
 *
 * @apiError {String} error Error message
 * @apiError (400) {String} error Invalid block height. Must be a number.
 * @apiError (404) {String} error Block with height {height} not found
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks/1000/transactions"
 */
router.get('/:height/transactions', (async (req: Request, res: Response) => {
    try {
        const height = parseInt(req.params.height);
        if (isNaN(height)) {
            return res.status(400).json({ error: 'Invalid block height. Must be a number.' });
        }
        const blockFromDB = await mongo
            .getDb()
            .collection('blocks')
            .findOne(
                { height },
                { projection: { transactions: 1, _id: 1 } } // Ensure _id is projected if needed for block ID
            );
        if (!blockFromDB) {
            return res.status(404).json({ error: `Block with height ${height} not found` });
        }
        let transformedTransactions: any[] = [];
        if (blockFromDB.transactions && Array.isArray(blockFromDB.transactions)) {
            transformedTransactions = blockFromDB.transactions.map((tx: any) => {
                const { data, ...restOfTx } = tx;
                return {
                    ...restOfTx,
                    data: transformTransactionData(data),
                };
            });
        }
        res.json({
            success: true,
            blockHeight: height,
            blockId: blockFromDB._id ? blockFromDB._id.toString() : undefined,
            transactions: transformedTransactions,
        });
    } catch (err) {
        logger.error(`Error fetching transactions for block ${req.params.height}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

/**
 * @api {get} /blocks/transaction/:txHash Get Block by Transaction Hash
 * @apiName GetBlockByTransactionHash
 * @apiGroup Blocks
 * @apiDescription Retrieves the complete block that contains a specific transaction by its hash
 *
 * @apiParam {String} txHash Transaction hash to search for
 *
 * @apiSuccess {Boolean} success True if request was successful
 * @apiSuccess {Object} block Complete block object containing the transaction
 * @apiSuccess {String} block.id Block identifier
 * @apiSuccess {Number} block.blockNum Block number
 * @apiSuccess {String} block.hash Block hash
 * @apiSuccess {String} block.phash Previous block hash
 * @apiSuccess {Number} block.timestamp Unix timestamp in milliseconds
 * @apiSuccess {String} block.witness Account that produced this block
 * @apiSuccess {Object[]} block.txs Array of all transactions in this block
 * @apiSuccess {String} block.signature Block signature
 * @apiSuccess {Number} block.steemBlockNum Corresponding Steem block number
 * @apiSuccess {Number} block.steemBlockTimestamp Steem block timestamp
 *
 * @apiError {String} error Error message
 * @apiError (404) {String} error Block containing transaction with hash {txHash} not found
 *
 * @apiExample {curl} Example request:
 * curl "http://localhost:3000/blocks/transaction/b0ccf46e49752aecfc2971ff4554d54482b788c8"
 */
router.get('/transaction/:txHash', (async (req: Request, res: Response) => {
    try {
        const txHash = req.params.txHash;

        // Find the block that contains a transaction with this hash
        const blockFromDB = await mongo.getDb().collection('blocks').findOne({
            'txs.hash': txHash
        });

        if (!blockFromDB) {
            return res.status(404).json({ 
                error: `Block containing transaction with hash ${txHash} not found` 
            });
        }

        const transformedBlock = transformBlockData(blockFromDB);
        res.json({ success: true, block: transformedBlock });
    } catch (err) {
        logger.error(`Error fetching block by transaction hash ${req.params.txHash}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

export default router;
