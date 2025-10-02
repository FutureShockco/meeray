import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import mongo from '../../mongo.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { BigIntMath, toBigInt, toDbString } from '../../utils/bigint.js';
import { generateFarmId, recalculateNativeFarmRewards } from '../../utils/farm.js';
import validate from '../../validation/index.js';
import { TokenData } from '../token/token-interfaces.js';
import { FarmCreateData, FarmData } from './farm-interfaces.js';


export async function validateTx(data: FarmCreateData, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        // totalRewards may be omitted for auto farms (mintable reward tokens); rewardsPerBlock is required
        if (!data.stakingToken || !data.rewardToken || !data.startBlock || !data.rewardsPerBlock) {
            logger.warn('[farm-create] Invalid data: Missing required fields (stakingToken, rewardToken, startBlock, rewardsPerBlock).');
            return { valid: false, error: 'missing required fields' };
        }

        if (!validate.bigint(data.rewardsPerBlock, false, false, toBigInt(1))) {
            logger.warn('[farm-create] rewardsPerBlock must be a positive bigint.');
            return { valid: false, error: 'invalid rewardsPerBlock' };
        }

        if (!validate.blockNumber(data.startBlock)) {
            logger.warn('[farm-create] Invalid startBlock. Ensure it is a valid block number.');
            return { valid: false, error: 'invalid startBlock' };
        }

        if (!await validate.tokenSymbols([data.stakingToken, data.rewardToken])) {
            logger.warn('[farm-create] Invalid token symbols provided.');
            return { valid: false, error: 'invalid token symbols' };
        }

        if (!await validate.tokenExists(data.stakingToken)) {
            logger.warn('[farm-create] Invalid token symbols provided.');
            return { valid: false, error: 'staking token does not exist' };
        }

        const rewardToken = await cache.findOnePromise('tokens', { symbol: data.rewardToken }) as TokenData;
        if (!rewardToken) {
            logger.warn(`[farm-create] Reward Token (${data.rewardToken}) not found.`);
            return { valid: false, error: 'reward token not found' };
        }
        // If totalRewards is provided, ensure the sender can supply those tokens (either has balance or is issuer and token isn't mint-only)
        if (data.totalRewards !== undefined) {
            // If sender is not the issuer, they must have the balance
            if (rewardToken.issuer !== sender) {
                if (!await validate.userBalances(sender, [{ symbol: data.rewardToken, amount: toBigInt(data.totalRewards) }])) {
                    logger.warn(`[farm-create] Staker ${sender} has insufficient balance of ${data.rewardToken}.`);
                    return { valid: false, error: 'insufficient balance' };
                }
            } else {
                // Sender is issuer: if token is not mintable, they still must have enough balance to cover totalRewards
                if (!rewardToken.mintable) {
                    if (!await validate.userBalances(sender, [{ symbol: data.rewardToken, amount: toBigInt(data.totalRewards) }])) {
                        logger.warn(`[farm-create] Issuer ${sender} does not have sufficient balance of non-mintable token ${data.rewardToken}.`);
                        return { valid: false, error: 'insufficient balance' };
                    }
                }
                // If issuer and mintable, OK (they can mint when needed)
            }
        } else {
            // Auto farms (no totalRewards provided) require the reward token to be mintable and sender must be issuer
            if (rewardToken.issuer !== sender) {
                logger.warn(`[farm-create] Sender ${sender} is not the issuer of reward token ${data.rewardToken}. Cannot create auto farm.`);
                return { valid: false, error: 'not token issuer' };
            }
            if (!rewardToken.mintable) {
                logger.warn(`[farm-create] Reward token ${data.rewardToken} is not mintable. Cannot create auto farm.`);
                return { valid: false, error: 'token not mintable' };
            }
        }
        if (rewardToken.symbol === config.nativeTokenSymbol && rewardToken.issuer === config.masterName) {
            if (data.weight !== undefined && !validate.integer(data.weight, true, false, 1000, 0)) {
                logger.warn(`[farm-create] Invalid weight: ${data.weight}. Must be between 0-1000.`);
                return { valid: false, error: 'invalid weight' };
            }
        }
        const farmId = generateFarmId(data.stakingToken, data.rewardToken);
        const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
        if (existingFarm && (existingFarm.status === 'active' || existingFarm.status === 'paused')) {
            logger.warn(`[farm-create] Farm with ID ${farmId} already exists.`);
            return { valid: false, error: 'farm already exists' };
        }
        if (data.minStakeAmount !== undefined && !validate.bigint(data.minStakeAmount, true, false, toBigInt(1))) {
            logger.warn('[farm-create] minStakeAmount must be a non-negative bigint if provided.');
            return { valid: false, error: 'invalid minStakeAmount' };
        }
        if (data.maxStakeAmount !== undefined && !validate.bigint(data.maxStakeAmount, false, false, toBigInt(1))) {
            logger.warn('[farm-create] maxStakeAmount must be a non-negative bigint if provided.');
            return { valid: false, error: 'invalid maxStakeAmount' };
        }
        if (data.maxStakeAmount && data.minStakeAmount && toBigInt(data.maxStakeAmount) < toBigInt(data.minStakeAmount)) {
            logger.warn('[farm-create] maxStakeAmount cannot be less than minStakeAmount.');
            return { valid: false, error: 'maxStakeAmount less than minStakeAmount' };
        }

        if (!(await validate.userBalances(sender, [{ symbol: config.nativeTokenSymbol, amount: toBigInt(config.farmCreationFee) }]))) return { valid: false, error: 'insufficient balance' };

        return { valid: true };
    } catch (error) {
        logger.error(`[farm-create] Error validating farm creation: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}

export async function processTx(data: FarmCreateData, sender: string, _id: string, _ts?: number): Promise<{ valid: boolean; error?: string }> {
    try {
        const farmId = generateFarmId(data.stakingToken, data.rewardToken);

        const senderAccount = await getAccount(sender);
        if (!senderAccount || !senderAccount.balances) {
            logger.error(`[farm-create] Critical: Sender account or balances not found for ${sender} during processing.`);
            return { valid: false, error: 'sender account not found' };
        }

        const feeDeducted = await adjustUserBalance(sender, config.nativeTokenSymbol, -toBigInt(config.farmCreationFee));
        if (!feeDeducted) {
            logger.error(`[farm-create] Failed to deduct farm creation fee from ${sender}.`);
            return { valid: false, error: 'failed to deduct farm creation fee' };
        }
        if (data.totalRewards !== undefined) {
            const rewardDeducted = await adjustUserBalance(sender, data.rewardToken, -toBigInt(data.totalRewards));
            if (!rewardDeducted) {
                logger.error(`[farm-create] Failed to deduct ${data.totalRewards} ${data.rewardToken} from ${sender} for farm creation.`);
                return { valid: false, error: 'failed to deduct reward token' };
            }
        }
        const rewardToken = await cache.findOnePromise('tokens', { symbol: data.rewardToken }) as TokenData;
        const isNativeFarm = data.rewardToken === config.nativeTokenSymbol && rewardToken.issuer === config.masterName;
        const farmWeight = data.weight !== undefined && isNativeFarm ? data.weight : 0;
        const isAuto = rewardToken.mintable && data.totalRewards === undefined ? true : false;
        const farmDocument: FarmData = {
            _id: farmId,
            farmId: farmId,
            stakingToken: data.stakingToken,
            rewardToken: data.rewardToken,
            startBlock: data.startBlock,
            totalRewards: data.totalRewards === undefined ? toDbString(0) : toDbString(data.totalRewards),
            rewardsPerBlock: data.rewardsPerBlock === undefined ? toDbString(0) : toDbString(data.rewardsPerBlock),
            minStakeAmount: data.minStakeAmount === undefined ? toDbString(toBigInt(0)) : toDbString(data.minStakeAmount),
            maxStakeAmount: data.maxStakeAmount === undefined ? toDbString(toBigInt(0)) : toDbString(data.maxStakeAmount),
            totalStaked: toDbString(0),
            status: 'active',
            weight: farmWeight,
            isNativeFarm: isNativeFarm,
            isAuto: isAuto,
            rewardBalance: toDbString(0),
            lastUpdatedBlock: chain.getLatestBlock()._id,
            createdAt: new Date().toISOString(),
            creator: sender,
        };
        const insertSuccess = await new Promise<boolean>(resolve => {
            cache.insertOne('farms', farmDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[farm-create] Failed to insert farm ${farmId} into cache: ${err || 'no result'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });

        if (!insertSuccess) {
            logger.error(`[farm-create] System error: Failed to insert farm ${farmId}.`);
            return { valid: false, error: 'failed to insert farm' };
        }

        logger.debug(`[farm-create] Farm ${farmId} for staking token ${data.stakingToken} rewarding ${data.rewardToken} created by ${sender}.`);

        // If this is a native farm created by the master account, recalculate rewards per block for all master native farms
        if (isNativeFarm && sender === config.masterName) {
            try {
                const recalcOk = await recalculateNativeFarmRewards();
                if (!recalcOk) {
                    logger.error('[farm-create] Recalculation of native farm rewards failed after creation; aborting transaction to trigger rollback.');
                    return { valid: false, error: 'failed to recalculate native farm rewards' };
                }
                logger.debug('[farm-create] Recalculated native farm rewards after creation.');
            } catch (err) {
                logger.error(`[farm-create] Error recalculating native farm rewards: ${err}; aborting transaction to trigger rollback.`);
                return { valid: false, error: 'failed to recalculate native farm rewards' };
            }
        }

        return { valid: true };
    } catch (error) {
        logger.error(`[farm-create] Error processing farm creation: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
