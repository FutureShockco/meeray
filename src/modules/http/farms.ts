import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// --- Farms ---
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const query: any = {};
    if (req.query.status) {
        query.status = req.query.status as string; // e.g., ACTIVE, ENDED
    }
    if (req.query.rewardTokenSymbol) {
        query.rewardTokenSymbol = req.query.rewardTokenSymbol as string;
    }
    try {
        const farms = await cache.findPromise('farms', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('farms').countDocuments(query);
        res.json({ data: farms, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching farms:', error);
        res.status(500).json({ message: 'Error fetching farms', error: error.message });
    }
}) as RequestHandler);

router.get('/:farmId', (async (req: Request, res: Response) => {
    const { farmId } = req.params;
    try {
        const farm = await cache.findOnePromise('farms', { _id: farmId });
        if (!farm) {
            return res.status(404).json({ message: `Farm ${farmId} not found.` });
        }
        res.json(farm);
    } catch (error: any) {
        logger.error(`Error fetching farm ${farmId}:`, error);
        res.status(500).json({ message: 'Error fetching farm', error: error.message });
    }
}) as RequestHandler);

// --- User Farm Positions ---
router.get('/positions/user/:userId', (async (req: Request, res: Response) => {
    const { userId } = req.params; // Assuming userId is the staker
    const { limit, skip } = getPagination(req);
    try {
        const positions = await cache.findPromise('userFarmPositions', { staker: userId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userFarmPositions').countDocuments({ staker: userId });
        res.json({ data: positions, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching farm positions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching farm positions for user', error: error.message });
    }
}) as RequestHandler);

router.get('/positions/farm/:farmId', (async (req: Request, res: Response) => {
    const { farmId } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const positions = await cache.findPromise('userFarmPositions', { farmId: farmId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userFarmPositions').countDocuments({ farmId: farmId });
        res.json({ data: positions, total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching Efarm positions for farm ${farmId}:`, error);
        res.status(500).json({ message: 'Error fetching farm positions for farm', error: error.message });
    }
}) as RequestHandler);

// Get specific user farm position by its composite ID (staker-farmId)
router.get('/positions/:positionId', (async (req: Request, res: Response) => {
    const { positionId } = req.params;
    try {
        const position = await cache.findOnePromise('userFarmPositions', { _id: positionId });
        if (!position) {
            return res.status(404).json({ message: `User farm position ${positionId} not found.` });
        }
        res.json(position);
    } catch (error: any) {
        logger.error(`Error fetching user farm position ${positionId}:`, error);
        res.status(500).json({ message: 'Error fetching user farm position', error: error.message });
    }
}) as RequestHandler);

// Get a specific user's farm position in a specific farm
router.get('/positions/user/:userId/farm/:farmId', (async (req: Request, res: Response) => {
    const { userId, farmId } = req.params;
    const positionId = `${userId}-${farmId}`; // Construct the _id for userFarmPositions
    try {
        const position = await cache.findOnePromise('userFarmPositions', { _id: positionId });
        if (!position) {
            return res.status(404).json({ message: `Farm position for user ${userId} in farm ${farmId} not found.` });
        }
        res.json(position);
    } catch (error: any) {
        logger.error(`Error fetching position for user ${userId} in farm ${farmId}:`, error);
        res.status(500).json({ message: 'Error fetching user farm position in farm', error: error.message });
    }
}) as RequestHandler);

export default router; 