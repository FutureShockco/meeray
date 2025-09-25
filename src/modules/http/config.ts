import express from 'express';

import chain from '../../chain.js';
import config from '../../config.js';

const router = express.Router();

router.get('/', (req, res) => {
    try {
        const latestBlock = chain.getLatestBlock();
        const blockNum = latestBlock ? latestBlock._id : 0;
        const currentConfig = config.read(blockNum);
        const response = {
            current: currentConfig,
            base: config,
            history: config.history,
            blockInfo: {
                currentBlock: blockNum,
                latestBlock: latestBlock
                    ? {
                          _id: latestBlock._id,
                          timestamp: latestBlock.timestamp,
                          witness: latestBlock.witness,
                      }
                    : null,
            },
            metadata: {
                endpoint: '/config',
                description: 'Complete configuration with hardfork updates applied',
                timestamp: new Date().toISOString(),
            },
        };

        res.json(response);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to retrieve configuration',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        });
    }
});

router.get('/current', (req, res) => {
    try {
        const latestBlock = chain.getLatestBlock();
        const blockNum = latestBlock ? latestBlock._id : 0;
        const currentConfig = config.read(blockNum);
        res.json({
            config: currentConfig,
            blockNum: blockNum,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to retrieve current configuration',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        });
    }
});

router.get('/history', (req, res) => {
    try {
        res.json({
            history: config.history,
            description: 'Hardfork configuration history by block number',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to retrieve configuration history',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        });
    }
});

export default router;
