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
    logger.info('[API /launchpad] Received request to list launchpads');
    try {
        // Example: Fetch all launchpads. Add query parameters for filtering/pagination later.
        const launchpads = await cache.findPromise('launchpads', {}); 

        if (!launchpads) {
            logger.info('[API /launchpad] No launchpads found or error fetching.');
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
// TODO: Add GET endpoint for user participation in a launchpad: /launchpad/:launchpadId/user/:userId
// TODO: Add GET endpoint for claimable tokens for a user in a launchpad: /launchpad/:launchpadId/user/:userId/claimable

export default router; 