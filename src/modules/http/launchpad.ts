import express, { Request, RequestHandler, Response, Router } from 'express';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import { formatTokenAmountForResponse } from '../../utils/http.js';
import { LaunchpadData } from '../../transactions/launchpad/launchpad-interfaces.js';

const router: Router = express.Router();

const transformLaunchpadData = (launchpadData: any): any => {
    if (!launchpadData) return launchpadData;
    const transformed = { ...launchpadData };
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    }
    const tokenSymbol = transformed.tokenSymbol || 'UNKNOWN'
    if (transformed.tokenomicsSnapshot) {
        const ts = { ...transformed.tokenomicsSnapshot };
        if (ts.totalSupply) {
            const formatted = formatTokenAmountForResponse(ts.totalSupply, tokenSymbol);
            ts.totalSupply = formatted.amount;
            ts.rawTotalSupply = formatted.rawAmount;
        }
        if (ts.allocations && Array.isArray(ts.allocations)) {
            ts.allocations = ts.allocations.map((alloc: any) => {
                const transformedAlloc = { ...alloc };
                if (transformedAlloc.amount) {
                    const formatted = formatTokenAmountForResponse(transformedAlloc.amount, tokenSymbol);
                    transformedAlloc.amount = formatted.amount;
                    transformedAlloc.rawAmount = formatted.rawAmount;
                }
                return transformedAlloc;
            });
        }
        transformed.tokenomicsSnapshot = ts;
    }
    if (transformed.presale) {
        const presale = { ...transformed.presale };
        const presaleNumericFields = ['goal', 'raisedAmount', 'minContribution', 'maxContribution', 'tokenPrice'];
        for (const field of presaleNumericFields) {
            if (presale[field]) {
                const appropriateSymbol = field === 'tokenPrice' ? tokenSymbol : 'STEEM'; 
                const formatted = formatTokenAmountForResponse(presale[field], appropriateSymbol);
                presale[field] = formatted.amount;
                presale[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
            }
        }
        if (presale.participants && Array.isArray(presale.participants)) {
            presale.participants = presale.participants.map((p: any) => {
                const participant = { ...p };
                const participantNumericFields = ['amountContributed', 'tokensAllocated', 'claimedAmount'];
                for (const field of participantNumericFields) {
                    if (participant[field]) {
                        
                        const appropriateSymbol = field === 'tokensAllocated' || field === 'claimedAmount' ? tokenSymbol : 'STEEM';
                        const formatted = formatTokenAmountForResponse(participant[field], appropriateSymbol);
                        participant[field] = formatted.amount;
                        participant[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
                    }
                }
                return participant;
            });
        }
        transformed.presale = presale;
    }
    const topLevelNumericFields = ['targetRaise', 'totalCommitted'];
    for (const field of topLevelNumericFields) {
        if (transformed[field]) {
            
            const formatted = formatTokenAmountForResponse(transformed[field], 'STEEM');
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }
    return transformed;
};


router.get('/', async (req: Request, res: Response) => {
    logger.debug('[API /launchpad] Received request to list launchpads');
    try {
        const query: any = {};
        if (req.query.status) {
            query.status = req.query.status;
        }
        const launchpadsFromDB = await cache.findPromise('launchpads', query) as LaunchpadData[] | null;
        if (!launchpadsFromDB || launchpadsFromDB.length === 0) {
            logger.debug('[API /launchpad] No launchpads found or error fetching.');
            res.status(200).json([]);
            return;
        }
        const launchpads = launchpadsFromDB.map(transformLaunchpadData);
        res.status(200).json(launchpads);
    } catch (error) {
        logger.error('[API /launchpad] Error listing launchpads:', error);
        if (error instanceof Error) {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

router.get('/:launchpadId', async (req: Request, res: Response) => {
    const { launchpadId } = req.params;
    logger.debug(`[API /launchpad/:launchpadId] Received request for launchpad: ${launchpadId}`);
    try {
        const launchpadFromDB = await cache.findOnePromise('launchpads', { _id: launchpadId });

        if (!launchpadFromDB) {
            logger.debug(`[API /launchpad/:launchpadId] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        const launchpad = transformLaunchpadData(launchpadFromDB);
        res.status(200).json(launchpad);
    } catch (error) {
        logger.error(`[API /launchpad/:launchpadId] Error fetching launchpad ${launchpadId}:`, error);
        if (error instanceof Error) {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});


router.get('/:launchpadId/user/:userId', async (req: Request, res: Response) => {
    const { launchpadId, userId } = req.params;
    logger.debug(`[API /launchpad/:launchpadId/user/:userId] Received request for user ${userId} participation in launchpad ${launchpadId}`);
    try {
        const launchpadFromDB = await cache.findOnePromise('launchpads', { _id: launchpadId });

        if (!launchpadFromDB) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        if (!launchpadFromDB.presale || !launchpadFromDB.presale.participants) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] Launchpad ${launchpadId} has no presale or participant data.`);
            res.status(404).json({ message: `No presale participation data found for launchpad ${launchpadId}` });
            return;
        }

        const participantRaw = launchpadFromDB.presale.participants.find((p: any) => p.userId === userId);

        if (!participantRaw) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] User ${userId} not found in participants for launchpad ${launchpadId}.`);
            res.status(404).json({ message: `User ${userId} did not participate in launchpad ${launchpadId}` });
            return;
        }

        const participant = { ...participantRaw };
        const tokenSymbol = launchpadFromDB.tokenSymbol || 'UNKNOWN';

        if (participant.amountContributed) {
            const formatted = formatTokenAmountForResponse(participant.amountContributed, 'STEEM');
            participant.amountContributed = formatted.amount;
            participant.rawAmountContributed = formatted.rawAmount;
        }
        if (participant.tokensAllocated) {
            const formatted = formatTokenAmountForResponse(participant.tokensAllocated, tokenSymbol);
            participant.tokensAllocated = formatted.amount;
            participant.rawTokensAllocated = formatted.rawAmount;
        }
        if (participant.claimedAmount) {
            const formatted = formatTokenAmountForResponse(participant.claimedAmount, tokenSymbol);
            participant.claimedAmount = formatted.amount;
            participant.rawClaimedAmount = formatted.rawAmount;
        }

        res.status(200).json(participant);
    } catch (error) {
        logger.error(`[API /launchpad/:launchpadId/user/:userId] Error fetching user participation for launchpad ${launchpadId}, user ${userId}:`, error);
        if (error instanceof Error) {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});


router.get('/:launchpadId/user/:userId/claimable', async (req: Request, res: Response) => {
    const { launchpadId, userId } = req.params;
    logger.debug(`[API /launchpad/:launchpadId/user/:userId/claimable] Received request for claimable tokens for user ${userId} in launchpad ${launchpadId}`);

    try {
        const launchpadFromDB = (await cache.findOnePromise('launchpads', { _id: launchpadId })) as any | null;

        if (!launchpadFromDB) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId/claimable] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        let totalAllocatedToUserBI = toBigInt(0);
        let claimedByUserBI = toBigInt(0);

        if (launchpadFromDB.presale && launchpadFromDB.presale.participants) {
            const participantRaw = launchpadFromDB.presale.participants.find((p: any) => p.userId === userId);
            if (participantRaw) {
                if (participantRaw.tokensAllocated && typeof participantRaw.tokensAllocated === 'string') {
                    totalAllocatedToUserBI += toBigInt(participantRaw.tokensAllocated);
                }

                if (participantRaw.claimedAmount && typeof participantRaw.claimedAmount === 'string') {
                    claimedByUserBI += toBigInt(participantRaw.claimedAmount);
                } else if (participantRaw.claimed === true && participantRaw.tokensAllocated && typeof participantRaw.tokensAllocated === 'string') {
                    claimedByUserBI += toBigInt(participantRaw.tokensAllocated);
                }
            }
        }

        const tokenomics = launchpadFromDB.tokenomicsSnapshot;
        if (tokenomics && tokenomics.allocations && tokenomics.totalSupply) {
            const totalSupplyBI = typeof tokenomics.totalSupply === 'string' ? toBigInt(tokenomics.totalSupply) : toBigInt(tokenomics.totalSupply); 
            tokenomics.allocations.forEach((allocation: any) => {
                if (allocation.customRecipientAddress === userId) {
                    let allocationAmountBI: bigint = toBigInt(0); 
                    if (allocation.amount && typeof allocation.amount === 'string') {
                        allocationAmountBI = toBigInt(allocation.amount);
                    } else if (allocation.percentage) {
                        allocationAmountBI = (toBigInt(Math.round(allocation.percentage * 100)) * totalSupplyBI) / toBigInt(10000);
                    }
                    if (allocationAmountBI) {
                        totalAllocatedToUserBI += allocationAmountBI;
                        if (allocation.claimedAmount && typeof allocation.claimedAmount === 'string') {
                            claimedByUserBI += toBigInt(allocation.claimedAmount);
                        } else if (allocation.claimed === true && allocationAmountBI) {
                            claimedByUserBI += allocationAmountBI; 
                        }
                    }
                }
            });
        }

        const claimableAmountBI = totalAllocatedToUserBI - claimedByUserBI;
        const tokenSymbol = launchpadFromDB.tokenSymbol || 'UNKNOWN';

        const totalAllocatedFormatted = formatTokenAmountForResponse(totalAllocatedToUserBI.toString(), tokenSymbol);
        const claimedFormatted = formatTokenAmountForResponse(claimedByUserBI.toString(), tokenSymbol);
        const claimableFormatted = formatTokenAmountForResponse((claimableAmountBI < toBigInt(0) ? toBigInt(0) : claimableAmountBI).toString(), tokenSymbol);

        res.status(200).json({
            launchpadId,
            userId,
            totalAllocated: totalAllocatedFormatted.amount,
            rawTotalAllocated: totalAllocatedFormatted.rawAmount,
            claimed: claimedFormatted.amount,
            rawClaimed: claimedFormatted.rawAmount,
            claimable: claimableFormatted.amount,
            rawClaimable: claimableFormatted.rawAmount,
        });
    } catch (error) {
        logger.error(
            `[API /launchpad/:launchpadId/user/:userId/claimable] Error fetching claimable tokens for launchpad ${launchpadId}, user ${userId}:`,
            error
        );
        if (error instanceof Error) {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});


router.get('/:launchpadId/participants', (async (req: Request, res: Response) => {
    try {
        const { launchpadId } = req.params;
        const limit = parseInt(req.query.limit as string) || 10;
        const offset = parseInt(req.query.offset as string) || 0;
        const lp = await cache.findOnePromise('launchpads', { _id: launchpadId });
        if (!lp || !lp.presale || !Array.isArray(lp.presale.participants)) {
            return res.status(404).json({ message: 'Launchpad or participants not found' });
        }
        const total = lp.presale.participants.length;
        const data = lp.presale.participants.slice(offset, offset + limit);
        res.json({ data, total, limit, offset });
    } catch (error: any) {
        logger.error('[API /launchpad/:launchpadId/participants] Error:', error);
        res.status(500).json({ message: 'Error fetching participants', error: error.message });
    }
}) as RequestHandler);


router.get('/:launchpadId/whitelist', (async (req: Request, res: Response) => {
    try {
        const { launchpadId } = req.params;
        const lp = await cache.findOnePromise('launchpads', { _id: launchpadId });
        if (!lp) return res.status(404).json({ message: 'Launchpad not found' });
        const whitelist = lp.presale?.whitelist || [];
        const whitelistEnabled = !!lp.presale?.whitelistEnabled;
        res.json({ whitelistEnabled, whitelist });
    } catch (error: any) {
        logger.error('[API /launchpad/:launchpadId/whitelist] Error:', error);
        res.status(500).json({ message: 'Error fetching whitelist', error: error.message });
    }
}) as RequestHandler);


router.get('/:launchpadId/settlement-preview', (async (req: Request, res: Response) => {
    try {
        const { launchpadId } = req.params;
        const lp = await cache.findOnePromise('launchpads', { _id: launchpadId });
        if (!lp || !lp.presale || !lp.presaleDetailsSnapshot) {
            return res.status(404).json({ message: 'Launchpad or presale data not found' });
        }
        const price = toBigInt(lp.presaleDetailsSnapshot.pricePerToken);
        const tokenDecimals = toBigInt(lp.tokenomicsSnapshot.tokenDecimals || 0);
        const scale = toBigInt(10) ** tokenDecimals;
        const participants = lp.presale.participants || [];
        const preview = participants.map((p: any) => {
            const contrib = toBigInt(p.quoteAmountContributed || '0');
            const alloc = price > toBigInt(0) ? (contrib * scale) / price : toBigInt(0);
            return {
                userId: p.userId,
                contributed: p.quoteAmountContributed,
                tokensAllocatedPreview: alloc.toString(),
            };
        });
        res.json({ data: preview });
    } catch (error: any) {
        logger.error('[API /launchpad/:launchpadId/settlement-preview] Error:', error);
        res.status(500).json({ message: 'Error computing preview', error: error.message });
    }
}) as RequestHandler);

export default router;
