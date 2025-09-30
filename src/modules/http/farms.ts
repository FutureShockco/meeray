import express, { Request, RequestHandler, Response, Router } from 'express';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { mongo } from '../../mongo.js';
import { toBigInt } from '../../utils/bigint.js';
import { formatTokenAmountForResponse } from '../../utils/http.js';
import tokenCache from '../../utils/tokenCache.js';
import chain from '../../chain.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

const transformFarmData = async (farmData: any): Promise<any> => {
    if (!farmData) return farmData;
    const transformed = { ...farmData };
    if (transformed._id && typeof transformed._id !== 'string') {
        // If _id is ObjectId
        transformed.id = transformed._id.toString();
        delete transformed._id;
    } else if (transformed._id) {
        // If _id is string, ensure it's called id for consistency or keep as _id
        // transformed.id = transformed._id; // Option to map string _id to id
        // delete transformed._id;
    }

    // Resolve token symbols (stakingToken/rewardToken may be stored as simple strings)
    let stakingTokenSymbol = 'LP_TOKEN';
    let rewardTokenSymbol = 'REWARD_TOKEN';
    try {
        if (transformed.stakingToken) {
            if (typeof transformed.stakingToken === 'string') {
                const tk = await tokenCache.getToken(transformed.stakingToken);
                stakingTokenSymbol = tk?.symbol || transformed.stakingToken;
            } else if (transformed.stakingToken.symbol) {
                stakingTokenSymbol = transformed.stakingToken.symbol;
            }
        }
        if (transformed.rewardToken) {
            if (typeof transformed.rewardToken === 'string') {
                const rt = await tokenCache.getToken(transformed.rewardToken);
                rewardTokenSymbol = rt?.symbol || transformed.rewardToken;
            } else if (transformed.rewardToken.symbol) {
                rewardTokenSymbol = transformed.rewardToken.symbol;
            }
        }
    } catch (err) {
        logger.debug('[farms] Could not resolve token symbols for farm transform', err);
    }

    // Format staking-related amounts using staking token decimals
    const stakingFields = ['totalStaked', 'minStakeAmount', 'maxStakeAmount'];
    for (const field of stakingFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], stakingTokenSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    // Determine rewardsRemaining: for non-auto farms use rewardBalance, for auto farms compute supplyLeft if possible
    try {
        if (transformed.isAuto) {
            const rt = await tokenCache.getToken(typeof transformed.rewardToken === 'string' ? transformed.rewardToken : transformed.rewardToken?.symbol);
            if (rt && rt.maxSupply) {
                const currentSupply = toBigInt(rt.currentSupply || '0');
                const maxSupply = toBigInt(rt.maxSupply);
                transformed.rewardsRemaining = (maxSupply - currentSupply).toString();
            } else {
                transformed.rewardsRemaining = null;
            }
        } else {
            transformed.rewardsRemaining = transformed.rewardBalance || '0';
        }
    } catch (err) {
        transformed.rewardsRemaining = transformed.rewardBalance || '0';
    }

    // Format reward-related amounts using reward token decimals
    const rewardFields = ['rewardsPerBlock', 'totalRewards', 'rewardsRemaining', 'rewardBalance'];
    for (const field of rewardFields) {
        if (transformed[field] !== undefined && transformed[field] !== null) {
            const formatted = formatTokenAmountForResponse(transformed[field], rewardTokenSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    // Include current block so UI can compute accrued rewards without an extra request
    try {
        transformed.currentBlock = chain.getLatestBlock().id;
    } catch (err) {
        transformed.currentBlock = undefined;
    }

    // Exposed flag to tell UI whether the farm is exhausted (no remaining rewards)
    try {
        const rawRem = transformed.rawRewardsRemaining;
        if (rawRem === null || rawRem === undefined) {
            transformed.isExhausted = false;
        } else {
            transformed.isExhausted = toBigInt(rawRem) <= 0n;
        }
    } catch (err) {
        transformed.isExhausted = false;
    }

    // APR is typically a percentage, so keep as raw value
    if (transformed.apr) {
        transformed.apr = toBigInt(transformed.apr).toString();
    }

    return transformed;
};

const transformUserFarmPositionData = async (positionData: any): Promise<any> => {
    if (!positionData) return positionData;
    const transformed = { ...positionData };
    // _id for userFarmPositions is typically a string like `userId-farmId`, so no ObjectId conversion needed.
    // We can choose to map it to `id` for consistency if desired.
    // if (transformed._id) {
    //     transformed.id = transformed._id;
    //     delete transformed._id;
    // }

    // Get token symbols and farm info for formatting and raw fields
    const farmId = transformed.farmId;
    let stakingTokenSymbol = 'LP_TOKEN';
    let rewardTokenSymbol = 'REWARD_TOKEN';
    let farmStatus: string | undefined = undefined;
    let farmRawRewardBalance: string | undefined = undefined;

    if (farmId) {
        try {
            const farm = await cache.findOnePromise('farms', { _id: farmId });
            if (farm) {
                stakingTokenSymbol = typeof farm.stakingToken === 'string' ? farm.stakingToken : farm.stakingToken?.symbol || stakingTokenSymbol;
                rewardTokenSymbol = typeof farm.rewardToken === 'string' ? farm.rewardToken : farm.rewardToken?.symbol || rewardTokenSymbol;
                farmStatus = farm.status;
                farmRawRewardBalance = farm.rewardBalance || undefined;
            }
        } catch (err) {
            logger.debug('[farms] Could not fetch farm while transforming user position', err);
        }
    }

    // Format staked amount using staking token decimals
    if (transformed.stakedAmount) {
        const formatted = formatTokenAmountForResponse(transformed.stakedAmount, stakingTokenSymbol);
        transformed.stakedAmount = formatted.amount;
        transformed.rawStakedAmount = formatted.rawAmount;
    }

    // Format reward amounts using reward token decimals
    const rewardFields = ['rewardsEarned', 'claimedRewards', 'pendingRewards'];
    for (const field of rewardFields) {
        if (transformed[field] !== undefined && transformed[field] !== null) {
            const formatted = formatTokenAmountForResponse(transformed[field], rewardTokenSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    // Expose raw lastHarvestBlock so UI can compute elapsed blocks precisely
    if (transformed.lastHarvestBlock !== undefined && transformed.lastHarvestBlock !== null) {
        transformed.rawLastHarvestBlock = Number(transformed.lastHarvestBlock);
    }

    // Expose farm status and raw rewardBalance so UI can stop calculating when ended/exhausted
    if (farmStatus !== undefined) transformed.farmStatus = farmStatus;
    if (farmRawRewardBalance !== undefined) transformed.rawFarmRewardBalance = farmRawRewardBalance;

    return transformed;
};

// --- Farms ---
router.get('/', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const query: any = {};
    if (req.query.status) {
        query.status = req.query.status as string; // e.g., ACTIVE, ENDED
    }
    if (req.query.rewardTokenSymbol) {
        query['rewardToken.symbol'] = req.query.rewardTokenSymbol as string;
    }
    try {
        const farmsFromDB = await cache.findPromise('farms', query, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('farms').countDocuments(query);
        const farms = await Promise.all((farmsFromDB || []).map(async (f: any) => await transformFarmData(f)));
        res.json({ data: farms, total, limit, skip });
    } catch (error: any) {
        logger.error('Error fetching farms:', error);
        res.status(500).json({ message: 'Error fetching farms', error: error.message });
    }
}) as RequestHandler);

router.get('/:farmId', (async (req: Request, res: Response) => {
    const { farmId } = req.params;
    try {
        const farmFromDB = await cache.findOnePromise('farms', { _id: farmId });
        if (!farmFromDB) {
            return res.status(404).json({ message: `Farm ${farmId} not found.` });
        }
        const farm = await transformFarmData(farmFromDB);
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
        const positionsFromDB = await cache.findPromise('userFarmPositions', { userId: userId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userFarmPositions').countDocuments({ userId: userId });
        // Format stakedAmount and reward amounts for each position using the correct farm token symbols
        const positions = await Promise.all((positionsFromDB || []).map(async (position) => await transformUserFarmPositionData(position)));
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
        const positionsFromDB = await cache.findPromise('userFarmPositions', { farmId: farmId }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('userFarmPositions').countDocuments({ farmId: farmId });
    const positions = await Promise.all((positionsFromDB || []).map(async (p) => await transformUserFarmPositionData(p)));
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
        const positionFromDB = await cache.findOnePromise('userFarmPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `User farm position ${positionId} not found.` });
        }
    const position = await transformUserFarmPositionData(positionFromDB);
    res.json(position);
    } catch (error: any) {
        logger.error(`Error fetching user farm position ${positionId}:`, error);
        res.status(500).json({ message: 'Error fetching user farm position', error: error.message });
    }
}) as RequestHandler);

// Get a specific user's farm position in a specific farm
router.get('/positions/user/:userId/farm/:farmId', (async (req: Request, res: Response) => {
    const { userId, farmId } = req.params;
    const positionId = `${userId}_${farmId}`; // Construct the _id for userFarmPositions
    try {
        const positionFromDB = await cache.findOnePromise('userFarmPositions', { _id: positionId });
        if (!positionFromDB) {
            return res.status(404).json({ message: `Farm position for user ${userId} in farm ${farmId} not found.` });
        }
    const position = await transformUserFarmPositionData(positionFromDB);
    res.json(position);
    } catch (error: any) {
        logger.error(`Error fetching position for user ${userId} in farm ${farmId}:`, error);
        res.status(500).json({ message: 'Error fetching user farm position in farm', error: error.message });
    }
}) as RequestHandler);

export default router;
