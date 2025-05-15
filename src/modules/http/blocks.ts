import express from 'express';
import { chain } from '../../chain.js';

const router = express.Router();

// GET /blocks/latest - returns the latest block
router.get('/latest', (_req: any, res: any) => {
    try {
        const latestBlock = chain.getLatestBlock?.();
        if (!latestBlock) {
            return res.status(404).json({ error: 'No blocks found' });
        }
        res.json(latestBlock);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router; 