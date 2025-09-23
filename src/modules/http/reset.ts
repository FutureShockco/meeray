import express from 'express';

import { chain } from '../../chain.js';
import logger from '../../logger.js';
import mining from '../../mining.js';

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        logger.info('[MINING-RESET] Manual mining reset requested via API');

        // Clear any existing mining timeout
        if (chain.worker) {
            clearTimeout(chain.worker);
            chain.worker = null;
            logger.info('[MINING-RESET] Cleared existing mining timeout');
        }

        // Reset timing state
        chain.lastBlockTime = 0;

        // Force restart mining with current state
        const latestBlock = chain.getLatestBlock();
        if (latestBlock) {
            logger.info(`[MINING-RESET] Restarting mining from block ${latestBlock._id}`);
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
        logger.error('[MINING-RESET] Error during mining reset:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset mining',
            details: error instanceof Error ? error.message : String(error),
        });
    }
});

export default router;
