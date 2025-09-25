import express from 'express';

import { chain } from '../../chain.js';
import logger from '../../logger.js';
import mining from '../../mining.js';

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        if (chain.worker) {
            clearTimeout(chain.worker);
            chain.worker = null;
            logger.info('[http-mining-reset] Cleared existing mining timeout');
        }
        chain.lastBlockTime = 0;
        const latestBlock = chain.getLatestBlock();
        if (latestBlock) {
            logger.info(`[http-mining-reset] Restarting mining from block ${latestBlock._id}`);
            mining.minerWorker(latestBlock);
            res.json({
                success: true,
                message: 'Mining reset successfully',
                latestBlock: latestBlock._id,
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Cannot get latest block from chain',
            });
        }
    } catch (error) {
        logger.error('[http-mining-reset] Error during mining reset:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset mining',
            details: error instanceof Error ? error.message : String(error),
        });
    }
});

export default router;
