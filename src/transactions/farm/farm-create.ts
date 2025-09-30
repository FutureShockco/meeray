import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import mongo from '../../mongo.js';
import { adjustUserBalance, getAccount } from '../../utils/account.js';
import { BigIntMath, toBigInt, toDbString } from '../../utils/bigint.js';
import { generateFarmId } from '../../utils/farm.js';
import validate from '../../validation/index.js';
import { TokenData } from '../token/token-interfaces.js';
import { FarmCreateData, FarmData } from './farm-interfaces.js';


export async function validateTx(data: FarmCreateData, sender: string): Promise<boolean> {
    try {
        if (!data.stakingToken || !data.rewardToken || !data.startBlock || !data.totalRewards || !data.rewardsPerBlock) {
            logger.warn('[farm-create] Invalid data: Missing required fields.');
            return false;
        }

        if (!validate.bigint(data.rewardsPerBlock, false, false, toBigInt(1))) {
            logger.warn('[farm-create] rewardsPerBlock must be a positive bigint.');
            return false;
        }

        if (!validate.blockNumber(data.startBlock)) {
            logger.warn('[farm-create] Invalid startBlock. Ensure it is a valid block number.');
            return false;
        }

        if (!await validate.tokenSymbols([data.stakingToken, data.rewardToken])) {
            logger.warn('[farm-create] Invalid token symbols provided.');
            return false;
        }

        if (!await validate.tokenExists(data.stakingToken)) {
            logger.warn('[farm-create] Invalid token symbols provided.');
            return false;
        }

        const rewardToken = await cache.findOnePromise('tokens', { symbol: data.rewardToken }) as TokenData;
        if (!rewardToken) {
            logger.warn(`[farm-create] Reward Token (${data.rewardToken}) not found.`);
            return false;
        }
        // If sender is not the token issuer and provided totalRewards, check balance
        if (rewardToken.issuer !== sender && data.totalRewards !== undefined && validate.bigint(data.totalRewards, false, false, toBigInt(1))) {
            if(!await validate.userBalances(sender, [{ symbol: data.rewardToken, amount: toBigInt(data.totalRewards) }])) {
                logger.warn(`[farm-create] Staker ${sender} has insufficient balance of ${data.rewardToken}.`);
                return false;
            }
        }
        else {
            if (rewardToken.issuer !== sender) {
                logger.warn(`[farm-create] Sender ${sender} is not the issuer of reward token ${data.rewardToken}. Token issuer: ${rewardToken.issuer}`);
                return false;
            }
            if (!rewardToken.mintable) {
                logger.warn(`[farm-create] Reward token ${data.rewardToken} is not mintable. Cannot create farm with non-mintable reward token.`);
                return false;
            }
        }
        if (rewardToken.symbol === config.nativeTokenSymbol && rewardToken.issuer === config.masterName) {
            if (data.weight !== undefined && !validate.integer(data.weight, true, false, 1000, 0)) {
                logger.warn(`[farm-create] Invalid weight: ${data.weight}. Must be between 0-1000.`);
                return false;
            }
        }
        const farmId = generateFarmId(data.stakingToken, data.rewardToken);
        const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
        if (existingFarm && (existingFarm.status === 'active' || existingFarm.status === 'paused')) {
            logger.warn(`[farm-create] Farm with ID ${farmId} already exists.`);
            return false;
        }
        if (data.minStakeAmount !== undefined && !validate.bigint(data.minStakeAmount, true, false, toBigInt(1))) {
            logger.warn('[farm-create] minStakeAmount must be a non-negative bigint if provided.');
            return false;
        }
        if (data.maxStakeAmount !== undefined && !validate.bigint(data.maxStakeAmount, false, false, toBigInt(1))) {
            logger.warn('[farm-create] maxStakeAmount must be a non-negative bigint if provided.');
            return false;
        }
        if (data.maxStakeAmount && data.minStakeAmount && toBigInt(data.maxStakeAmount) < toBigInt(data.minStakeAmount)) {
            logger.warn('[farm-create] maxStakeAmount cannot be less than minStakeAmount.');
            return false;
        }

        if (!(await validate.userBalances(sender, [{ symbol: config.nativeTokenSymbol, amount: toBigInt(config.farmCreationFee) }]))) return false;

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error validating farm creation: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmCreateData, sender: string, _id: string, _ts?: number): Promise<boolean> {
    try {
        const farmId = generateFarmId(data.stakingToken, data.rewardToken);

        const senderAccount = await getAccount(sender);
        if (!senderAccount || !senderAccount.balances) {
            logger.error(`[farm-create] Critical: Sender account or balances not found for ${sender} during processing.`);
            return false;
        }

        const feeDeducted = await adjustUserBalance(sender, config.nativeTokenSymbol, toBigInt(-config.farmCreationFee));
        if (!feeDeducted) {
            logger.error(`[token-create:process] Failed to deduct token creation fee from ${sender}.`);
            return false;
        }
        if (data.totalRewards !== undefined) {
            const rewardDeducted = await adjustUserBalance(sender, data.rewardToken, toBigInt(-data.totalRewards));
            if (!rewardDeducted) {
                logger.error(`[farm-create] Failed to deduct ${data.totalRewards} ${data.rewardToken} from ${sender} for farm creation.`);
                return false;
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
            totalRewards: toDbString(data.totalRewards),
            rewardsPerBlock: toDbString(data.rewardsPerBlock),
            minStakeAmount: data.minStakeAmount === undefined ? toBigInt(0) : toDbString(data.minStakeAmount),
            maxStakeAmount: data.maxStakeAmount === undefined ? toBigInt(0) : toDbString(data.maxStakeAmount),
            totalStaked: toDbString(0),
            status: 'active',
            weight: farmWeight,
            isNativeFarm: isNativeFarm,
            isAuto: isAuto,
            rewardBalance: toDbString(0),
            lastUpdatedBlock: chain.getLatestBlock().id,
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
            return false;
        }

        logger.debug(`[farm-create] Farm ${farmId} for staking token ${data.stakingToken} rewarding ${data.rewardToken} created by ${sender}.`);

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error processing farm creation: ${error}`);
        return false;
    }
}
