import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import logger from '../../logger.js';
// Remove imports related to POST data and transaction module if no longer needed here
// import { TransactionType } from '../../transactions/types.js';
// import { LaunchpadLaunchTokenData } from '../../transactions/launchpad/launchpad-launch-token.js';
// import { LaunchpadParticipatePresaleData } from '../../transactions/launchpad/launchpad-participate-presale.js';
// import { LaunchpadClaimTokensData } from '../../transactions/launchpad/launchpad-claim-tokens.js';
// import { Transaction as TransactionInterface } from '../../transactions/index.js';

const router: Router = express.Router();

// GET endpoint to list all launchpad projects
const listLaunchpadsHandler: RequestHandler = async (req: Request, res: Response) => {
    logger.debug('[API /launchpad] Received request to list launchpads');
    try {
        // Example: Fetch all launchpads. Add query parameters for filtering/pagination later.
        const launchpads = await cache.findPromise('launchpads', {}); 

        if (!launchpads) {
            logger.debug('[API /launchpad] No launchpads found or error fetching.');
            res.status(404).json({ message: 'No launchpads found' });
            return;
        }

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
        const launchpad = await cache.findOnePromise('launchpads', { _id: launchpadId });

        if (!launchpad) {
            logger.debug(`[API /launchpad/:launchpadId] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

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
        const launchpad = await cache.findOnePromise('launchpads', { _id: launchpadId }) as any; // Cast to any to access presale.participants

        if (!launchpad) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        if (!launchpad.presale || !launchpad.presale.participants) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] Launchpad ${launchpadId} has no presale or participant data.`);
            res.status(404).json({ message: `No presale participation data found for launchpad ${launchpadId}` });
            return;
        }

        const participant = launchpad.presale.participants.find((p: any) => p.userId === userId);

        if (!participant) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId] User ${userId} not found in participants for launchpad ${launchpadId}.`);
            res.status(404).json({ message: `User ${userId} did not participate in launchpad ${launchpadId}` });
            return;
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
        const launchpad = await cache.findOnePromise('launchpads', { _id: launchpadId }) as any | null; // Cast to any for now, will use Launchpad interface later

        if (!launchpad) {
            logger.debug(`[API /launchpad/:launchpadId/user/:userId/claimable] Launchpad ${launchpadId} not found.`);
            res.status(404).json({ message: `Launchpad with ID ${launchpadId} not found` });
            return;
        }

        // Assuming a Launchpad interface structure from your previous context
        // We need to determine the user's total allocation and how much has been claimed.

        let totalAllocatedToUser = 0;
        let claimedByUser = 0;

        // 1. Check presale participation
        if (launchpad.presale && launchpad.presale.participants) {
            const participant = launchpad.presale.participants.find((p: any) => p.userId === userId);
            if (participant && participant.tokensAllocated) {
                totalAllocatedToUser += participant.tokensAllocated;
                if (participant.claimed) {
                    // This simple boolean might mean all of presale allocation is claimed.
                    // A more granular `claimedAmount` would be better.
                    // For now, if `claimed` is true, assume all `tokensAllocated` from presale are claimed.
                    claimedByUser += participant.tokensAllocated; 
                }
            }
        }
        
        // 2. Check other allocations (e.g., airdrops, team vesting if applicable to this endpoint's purpose)
        // This part is more complex and depends on how TokenAllocation is structured and if this endpoint
        // should cover all types of claimable tokens or just presale-related ones.
        // For now, let's assume this endpoint is primarily for presale claimable amounts 
        // or simple direct allocations defined in launchpad.allocations (if such a field existed).

        // Accessing tokenomicsSnapshot for total supply and allocations
        const tokenomics = launchpad.tokenomicsSnapshot; // Assuming type Tokenomics
        if (tokenomics && tokenomics.allocations) {
            tokenomics.allocations.forEach((allocation: any) => { // Assuming type TokenAllocation
                // If the allocation is directly for this user (e.g. customRecipientAddress or airdrop to userId)
                // This is a simplified example. Real logic would depend on allocation.recipient type and vesting.
                if (allocation.customRecipientAddress === userId /* && allocation.recipient === SomeAirdropOrDirectRecipientType */) {
                    // This calculation is illustrative. Vesting logic would be critical here.
                    // Percentage of total supply
                    const allocationAmount = (allocation.percentage / 100) * tokenomics.totalSupply;
                    totalAllocatedToUser += allocationAmount;
                    // TODO: Determine how much of *this specific allocation* has been claimed.
                    // This would require tracking claims against specific allocations, not just a global `claimedByUser`.
                }
            });
        }

        const claimableAmount = totalAllocatedToUser - claimedByUser;

        res.status(200).json({
            launchpadId,
            userId,
            totalAllocated: totalAllocatedToUser,
            claimed: claimedByUser,
            claimable: Math.max(0, claimableAmount) // Ensure it doesn't go negative
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