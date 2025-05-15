import express from 'express';
import mining from '../../mining.js';

const router = express.Router();

router.get('/', async (req, res) => {
    mining.mineBlock((err, block) => {
        if (err) {
            res.status(500).json({ success: false, error: 'Failed to mine block', block });
        } else {
            res.json({ success: true, block });
        }
    });
});

export default router; 