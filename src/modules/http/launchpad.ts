import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint.js';
import { formatTokenAmountForResponse, formatTokenAmountSimple } from '../../utils/http.js';
// Remove imports related to POST data and transaction module if no longer needed here
// import { TransactionType } from '../../transactions/types.js';
// import { LaunchpadLaunchTokenData } from '../../transactions/launchpad/launchpad-launch-token.js';
// import { LaunchpadParticipatePresaleData } from '../../transactions/launchpad/launchpad-participate-presale.js';
// import { LaunchpadClaimTokensData } from '../../transactions/launchpad/launchpad-claim-tokens.js';
// import { Transaction as TransactionInterface } from '../../transactions/index.js';

const router: Router = express.Router();

// Helper to transform numeric string fields in a launchpad object
const transformLaunchpadData = (launchpadData: any): any => {
    if (!launchpadData) return launchpadData;
    const transformed = { ...launchpadData };

    // Transform _id to id
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    }

    // Get token symbol for formatting
    const tokenSymbol = transformed.tokenSymbol || 'UNKNOWN';

    // Tokenomics Snapshot
    if (transformed.tokenomicsSnapshot) {
        const ts = { ...transformed.tokenomicsSnapshot };
        if (ts.totalSupply) {
            const formatted = formatTokenAmountForResponse(ts.totalSupply, tokenSymbol);
            ts.totalSupply = formatted.amount;
            ts.rawTotalSupply = formatted.rawAmount;
        }
        // allocations[].amount (if it exists and is a string)
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

    // Presale Data
    if (transformed.presale) {
        const presale = { ...transformed.presale };
        const presaleNumericFields = ['goal', 'raisedAmount', 'minContribution', 'maxContribution', 'tokenPrice'];
        for (const field of presaleNumericFields) {
            if (presale[field]) {
                // For presale amounts, we need to determine the appropriate token symbol
                // This might be the funding token (e.g., STEEM) or the project token
                const appropriateSymbol = field === 'tokenPrice' ? tokenSymbol : 'STEEM'; // Assuming STEEM as funding token
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
                        // Determine appropriate token symbol for each field
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
    
    // Other potential top-level numeric fields
    const topLevelNumericFields = ['targetRaise', 'totalCommitted'];
    for (const field of topLevelNumericFields) {
        if (transformed[field]) {
            // These are typically in the funding token (e.g., STEEM)
            const formatted = formatTokenAmountForResponse(transformed[field], 'STEEM');
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    return transformed;
};

// GET endpoint to list all launchpad projects
const listLaunchpadsHandler: RequestHandler = async (req: Request, res: Response) => {
    logger.debug('[API /launchpad] Received request to list launchpads');
    try {
        const launchpadsFromDB = await cache.findPromise('launchpads', {}); 

        if (!launchpadsFromDB || launchpadsFromDB.length === 0) {
            logger.debug('[API /launchpad] No launchpads found or error fetching.');
            // Return empty array if none found, consistent with other list endpoints
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
};

router.get('/', listLaunchpadsHandler);

// TODO: Add GET endpoint for a specific launchpad: /launchpad/:launchpadId
const getLaunchpadByIdHandler: RequestHandler = async (req: Request, res: Response) => {
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
};
router.get('/:launchpadId', getLaunchpadByIdHandler);

// TODO: Add GET endpoint for user participation in a launchpad: /launchpad/:launchpadId/user/:userId
const getUserParticipationHandler: RequestHandler = async (req: Request, res: Response) => {
    const { launchpadId, userId } = req.params;
    logger.debug(`[API /launchpad/:launchpadId/user/:userId] Received request for user ${userId} participation in launchpad ${launchpadId}`);
    try {
        const launchpadFromDB = await cache.findOnePromise('launchpads', { _id: launchpadId });

        if (!launchpadFromDB) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        // The launchpad itself might have fields to transform, though this route focuses on a participant
        // For consistency, we could transform the whole launchpad then extract, or just transform participant data
        // Let's assume the full launchpad transform might be too broad here if only participant is returned.

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
        
        // Transform only the participant object for this specific route
        const participant = { ...participantRaw };
        const tokenSymbol = launchpadFromDB.tokenSymbol || 'UNKNOWN';
        
        // Format contribution amounts (in STEEM) and token amounts (in project token)
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
};
router.get('/:launchpadId/user/:userId', getUserParticipationHandler);

// TODO: Add GET endpoint for claimable tokens for a user in a launchpad: /launchpad/:launchpadId/user/:userId/claimable
const getClaimableTokensHandler: RequestHandler = async (req: Request, res: Response) => {
    const { launchpadId, userId } = req.params;
    logger.debug(`[API /launchpad/:launchpadId/user/:userId/claimable] Received request for claimable tokens for user ${userId} in launchpad ${launchpadId}`);

    try {
        const launchpadFromDB = await cache.findOnePromise('launchpads', { _id: launchpadId }) as any | null;

        if (!launchpadFromDB) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId/claimable] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        // For calculations, convert to BigInt, then convert result back to string for response
        let totalAllocatedToUserBI = BigInt(0);
        let claimedByUserBI = BigInt(0);

        if (launchpadFromDB.presale && launchpadFromDB.presale.participants) {
            const participantRaw = launchpadFromDB.presale.participants.find((p: any) => p.userId === userId);
            if (participantRaw) {
                if (participantRaw.tokensAllocated && typeof participantRaw.tokensAllocated === 'string') {
                    totalAllocatedToUserBI += toBigInt(participantRaw.tokensAllocated);
                }
                 // Assuming participantRaw.claimed might be a boolean or participantRaw.claimedAmount is a numeric string
                if (participantRaw.claimedAmount && typeof participantRaw.claimedAmount === 'string') {
                    claimedByUserBI += toBigInt(participantRaw.claimedAmount);
                } else if (participantRaw.claimed === true && participantRaw.tokensAllocated && typeof participantRaw.tokensAllocated === 'string') {
                    // If only a boolean `claimed` flag exists, and it's true, assume all presale tokensAllocated are claimed.
                    claimedByUserBI += toBigInt(participantRaw.tokensAllocated);
                }
            }
        }
        
        const tokenomics = launchpadFromDB.tokenomicsSnapshot;
        if (tokenomics && tokenomics.allocations && tokenomics.totalSupply) {
            const totalSupplyBI = typeof tokenomics.totalSupply === 'string' ? toBigInt(tokenomics.totalSupply) : BigInt(tokenomics.totalSupply); // Ensure totalSupply is BigInt
            tokenomics.allocations.forEach((allocation: any) => {
                if (allocation.customRecipientAddress === userId) {
                    // Ensure allocation.amount is used if available, otherwise calculate from percentage
                    let allocationAmountBI: bigint = BigInt(0); // Initialize to 0
                    if (allocation.amount && typeof allocation.amount === 'string') {
                        allocationAmountBI = toBigInt(allocation.amount);
                    } else if (allocation.percentage) {
                        // Note: BigInt division truncates. For precision with percentages,
                        // multiply first, then divide: (percentage * totalSupplyBI) / 100n
                        // Or, ensure percentage calculations are done carefully if smallest units are critical.
                        // Here, assuming percentage is a whole number like 10 for 10%.
                        allocationAmountBI = (BigInt(Math.round(allocation.percentage * 100)) * totalSupplyBI) / BigInt(10000);
                    }
                    if (allocationAmountBI) {
                         totalAllocatedToUserBI += allocationAmountBI;
                         // TODO: Add logic for claimed amounts against specific non-presale allocations if needed
                         // This might require a field like `allocation.claimedAmount` (numeric string)
                         if (allocation.claimedAmount && typeof allocation.claimedAmount === 'string') {
                             claimedByUserBI += toBigInt(allocation.claimedAmount);
                         } else if (allocation.claimed === true && allocationAmountBI) {
                             claimedByUserBI += allocationAmountBI; // if boolean flag means fully claimed
                         }
                    }
                }
            });
        }

        const claimableAmountBI = totalAllocatedToUserBI - claimedByUserBI;
        const tokenSymbol = launchpadFromDB.tokenSymbol || 'UNKNOWN';

        // Format all amounts with proper decimals
        const totalAllocatedFormatted = formatTokenAmountForResponse(totalAllocatedToUserBI.toString(), tokenSymbol);
        const claimedFormatted = formatTokenAmountForResponse(claimedByUserBI.toString(), tokenSymbol);
        const claimableFormatted = formatTokenAmountForResponse(
            (claimableAmountBI < BigInt(0) ? BigInt(0) : claimableAmountBI).toString(), 
            tokenSymbol
        );

        res.status(200).json({
            launchpadId,
            userId,
            totalAllocated: totalAllocatedFormatted.amount,
            rawTotalAllocated: totalAllocatedFormatted.rawAmount,
            claimed: claimedFormatted.amount,
            rawClaimed: claimedFormatted.rawAmount,
            claimable: claimableFormatted.amount,
            rawClaimable: claimableFormatted.rawAmount
        });

    } catch (error) {
        logger.error(`[API /launchpad/:launchpadId/user/:userId/claimable] Error fetching claimable tokens for launchpad ${launchpadId}, user ${userId}:`, error);
        if (error instanceof Error) {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
};
router.get('/:launchpadId/user/:userId/claimable', getClaimableTokensHandler);

export default router; 