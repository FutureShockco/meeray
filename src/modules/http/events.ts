import express, { Request, RequestHandler, Response, Router } from 'express';

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

        // Support new category + action structure with multiple values
        if (req.query.category) {
            const categories = Array.isArray(req.query.category) ? req.query.category : [req.query.category];
            query.category = categories.length === 1 ? categories[0] : { $in: categories };
        }

        if (req.query.action) {
            const actions = Array.isArray(req.query.action) ? req.query.action : [req.query.action];
            query.action = actions.length === 1 ? actions[0] : { $in: actions };
        }

        // Legacy support for type field
        if (req.query.type) {
            query.type = req.query.type;
        }

        if (req.query.actor) {
            query.actor = req.query.actor;
        }

        if (req.query.transactionId) {
            query.transactionId = req.query.transactionId;
        }

        if (req.query.poolId) {
            // Search for poolId in the event data for pool-related events
            // Pool create events use _id, while other pool events use poolId
            query.$or = [{ 'data.poolId': req.query.poolId }, { 'data._id': req.query.poolId }];
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
            skip,
        });

        const allEvents = await cache.findPromise('events', query);
        const total = allEvents ? allEvents.length : 0;

        res.json({
            success: true,
            data: events || [],
            total,
            limit,
            skip,
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
            types,
        });
    } catch (err) {
        logger.error('Error fetching event types:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// New endpoint: Get all categories and actions
router.get('/categories', (async (req: Request, res: Response) => {
    try {
        const events = await cache.findPromise('events', {});
        if (!events) {
            return res.json({ success: true, categories: [], actions: [], categoryActions: {} });
        }

        const categories = [...new Set(events.map(event => event.category).filter(Boolean))];
        const actions = [...new Set(events.map(event => event.action).filter(Boolean))];

        // Group actions by category
        const categoryActions: Record<string, string[]> = {};
        events.forEach(event => {
            if (event.category && event.action) {
                if (!categoryActions[event.category]) {
                    categoryActions[event.category] = [];
                }
                if (!categoryActions[event.category].includes(event.action)) {
                    categoryActions[event.category].push(event.action);
                }
            }
        });

        res.json({
            success: true,
            categories,
            actions,
            categoryActions,
        });
    } catch (err) {
        logger.error('Error fetching event categories:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

// New endpoint: Get event statistics by category
router.get('/stats', (async (req: Request, res: Response) => {
    try {
        const events = await cache.findPromise('events', {});
        if (!events) {
            return res.json({ success: true, stats: {} });
        }

        const stats: Record<string, { total: number; actions: Record<string, number> }> = {};

        events.forEach(event => {
            if (event.category) {
                if (!stats[event.category]) {
                    stats[event.category] = { total: 0, actions: {} };
                }
                stats[event.category].total++;

                if (event.action) {
                    if (!stats[event.category].actions[event.action]) {
                        stats[event.category].actions[event.action] = 0;
                    }
                    stats[event.category].actions[event.action]++;
                }
            }
        });

        res.json({
            success: true,
            stats,
        });
    } catch (err) {
        logger.error('Error fetching event statistics:', err);
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
            event,
        });
    } catch (err) {
        logger.error(`Error fetching event ${req.params.id}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

export default router;
