import express from 'express';
import mongo from '../../mongo.js';

const router = express.Router();

// GET /accounts/:name
router.get('/:name', async (req: any, res: any) => {
    try {
        const account = await mongo.getDb().collection('accounts').findOne({ _id: req.params.name });
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        res.json({ success: true, account });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router; 