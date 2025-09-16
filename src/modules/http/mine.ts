import express from 'express';
import mining from '../../mining.js';
import { chain } from '../../chain.js';

const router = express.Router();

router.get('/', async (req, res) => {
    // First abort any existing mining to prevent conflicts
    mining.abortAndRestartMining();
    
    // Wait a bit longer to ensure the abort completes and chain state is stable
    setTimeout(() => {
        // Double-check that we're using the latest chain state
        const latestBlock = chain.getLatestBlock();
        if (!latestBlock) {
            res.status(500).json({ success: false, error: 'Cannot get latest block from chain' });
            return;
        }
        
        mining.mineBlock((err, block) => {
            if (err) {
                res.status(500).json({ success: false, error: 'Failed to mine block', block });
            } else {
                res.json({ success: true, block });
            }
        });
    }, 300); // Increased delay to 300ms
});

export default router; 