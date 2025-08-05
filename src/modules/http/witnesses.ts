import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { AccountDoc } from '../../mongo.js'; // Assuming AccountDoc is exported from mongo.ts and includes witness fields
import { toBigInt } from '../../utils/bigint.js';
import { formatTokenAmountForResponse, formatTokenBalancesForResponse } from '../../utils/http.js';
import config from '../../config.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

// GET /witnesses - List top witnesses by vote weight
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    try {
        const query = { witnessPublicKey: { $exists: true, $ne: '' } }; // Consider only accounts that declared a public key
        const witnessesFromDB = await mongo.getDb().collection<AccountDoc>('accounts')
            .find(query)
            .sort({ totalVoteWeight: -1, name: 1 })
            .limit(limit)
            .skip(skip)
            .toArray();
        
        const total = await mongo.getDb().collection<AccountDoc>('accounts').countDocuments(query);

        const witnesses = witnessesFromDB.map((wit: any) => {
            const { _id, totalVoteWeight, balances, ...rest } = wit;
            const transformedWit: any = { ...rest };
            if (_id) {
                transformedWit.id = _id.toString();
            }
            if (totalVoteWeight) {
                transformedWit.totalVoteWeight = formatTokenAmountForResponse(totalVoteWeight, config.nativeToken);
            }
            if (balances) {
                // Format token balances with proper decimals
                transformedWit.balances = formatTokenBalancesForResponse(balances);
            }
            return transformedWit;
        });

        res.json({ data: witnesses, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching witnesses:', error);
        res.status(500).json({ message: 'Error fetching witnesses', error: error.message });
    }
}) as RequestHandler);

// GET /witnesses/:name/details - Get account details (focusing on witness aspects)
// This is essentially the same as /accounts/:name but under the /witnesses route for semantic grouping.
router.get('/:name/details', (async (req: Request, res: Response) => {
    const { name } = req.params;
    try {
        const accountFromDB = await cache.findOnePromise('accounts', { name: name }) as AccountDoc | null;
        if (!accountFromDB) {
            return res.status(404).json({ message: `Account ${name} not found.` });
        }
        
        const { _id, totalVoteWeight, balances, ...rest } = accountFromDB as any;
        const account: any = { ...rest };
        if (_id) {
            account.id = _id.toString();
        }
        if (totalVoteWeight) {
            account.totalVoteWeight = toBigInt(totalVoteWeight as string).toString();
        }
        if (balances) {
            const newBalances: Record<string, string> = {};
            for (const tokenSymbol in balances) {
                newBalances[tokenSymbol] = toBigInt(balances[tokenSymbol] as string).toString();
            }
            account.balances = newBalances;
        }

        res.json(account);
    } catch (error: any) {
        logger.error(`Error fetching account details for ${name}:`, error);
        res.status(500).json({ message: 'Error fetching account details', error: error.message });
    }
}) as RequestHandler);

// GET /witnesses/votescastby/:voterName - List witnesses an account has voted for
router.get('/votescastby/:voterName', (async (req: Request, res: Response) => {
    const { voterName } = req.params;
    try {
        const voter = await cache.findOnePromise('accounts', { name: voterName }) as AccountDoc | null;
        if (!voter) {
            return res.status(404).json({ message: `Voter account ${voterName} not found.` });
        }
        res.json({ votedWitnesses: voter.votedWitnesses || [] });
    } catch (error: any) {
        logger.error(`Error fetching votes cast by ${voterName}:`, error);
        res.status(500).json({ message: 'Error fetching votes cast by user', error: error.message });
    }
}) as RequestHandler);

// GET /witnesses/votersfor/:witnessName - List accounts that voted for a specific witness
router.get('/votersfor/:witnessName', (async (req: Request, res: Response) => {
    const { witnessName } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        // This query can be inefficient on large datasets if 'votedWitnesses' array is not indexed appropriately for $in or $elemMatch.
        // MongoDB does allow indexing arrays. Consider if this endpoint is critical for performance.
        const query = { votedWitnesses: witnessName };
        const voters = await mongo.getDb().collection<AccountDoc>('accounts')
            .find(query)
            .limit(limit)
            .skip(skip)
            .project({ name: 1, _id: 0 }) // Only return voter names
            .toArray();
        
        const total = await mongo.getDb().collection<AccountDoc>('accounts').countDocuments(query);

        res.json({ data: voters.map(v => v.name), total, limit, skip });
    } catch (error: any) {
        logger.error(`Error fetching voters for witness ${witnessName}:`, error);
        res.status(500).json({ message: 'Error fetching voters for witness', error: error.message });
    }
}) as RequestHandler);

export default router; 