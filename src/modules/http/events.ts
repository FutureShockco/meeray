import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import logger from '../../logger.js';

const router: Router = express.Router();

const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

router.get('/', (async (req: Request, res: Response) => {
    try {
        const { limit, skip } = getPagination(req);
        
        const query: any = {};
        
        if (req.query.type) {
            query.type = req.query.type;
        }
        
        if (req.query.actor) {
            query.actor = req.query.actor;
        }
        
        if (req.query.transactionId) {
            query.transactionId = req.query.transactionId;
        }
        
        if (req.query.startTime) {
            query.timestamp = { $gte: req.query.startTime };
        }
        if (req.query.endTime) {
            if (!query.timestamp) query.timestamp = {};
            query.timestamp.$lte = req.query.endTime;
        }
        
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        
        const events = await cache.findPromise('events', query, {
            sort: { timestamp: sortDirection },
            limit,
            skip
        });
        
        const allEvents = await cache.findPromise('events', query);
        const total = allEvents ? allEvents.length : 0;
        
        res.json({
            success: true,
            data: events || [],
            total,
            limit,
            skip
        });
    } catch (err) {
        logger.error('Error fetching events:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

router.get('/types', (async (req: Request, res: Response) => {
    try {
        const events = await cache.findPromise('events', {});
        const types = events ? [...new Set(events.map(event => event.type))] : [];
        
        res.json({
            success: true,
            types
        });
    } catch (err) {
        logger.error('Error fetching event types:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

router.get('/:id', (async (req: Request, res: Response) => {
    try {
        const event = await cache.findOnePromise('events', { _id: req.params.id });
        
        if (!event) {
            return res.status(404).json({ error: `Event with ID ${req.params.id} not found` });
        }
        
        res.json({
            success: true,
            event
        });
    } catch (err) {
        logger.error(`Error fetching event ${req.params.id}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

export default router; 