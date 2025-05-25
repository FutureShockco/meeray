import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { FarmCreateData, FarmCreateDataDB, Farm, FarmDB } from './farm-interfaces.js';
import { convertToBigInt, convertToString, toString, BigIntMath } from '../../utils/bigint-utils.js';
import { getAccount } from '../../utils/account-utils.js';

const NUMERIC_FIELDS_FARM_CREATE: Array<keyof FarmCreateData> = ['totalRewards', 'rewardsPerBlock', 'minStakeAmount', 'maxStakeAmount'];
const NUMERIC_FIELDS_FARM: Array<keyof Farm> = ['totalRewards', 'rewardsPerBlock', 'minStakeAmount', 'maxStakeAmount', 'totalStaked'];

// Helper function to generate a unique and deterministic farm ID
function generateFarmId(stakingTokenSymbol: string, rewardTokenSymbol: string, rewardTokenIssuer: string): string {
    // Consider a more robust ID generation, e.g., crypto hash if needed for global uniqueness
    return `FARM_${stakingTokenSymbol}_${rewardTokenSymbol}_${rewardTokenIssuer}`.toUpperCase();
}

export async function validateTx(data: FarmCreateDataDB, sender: string): Promise<boolean> {
    try {
        const farmData = convertToBigInt<FarmCreateData>(data, NUMERIC_FIELDS_FARM_CREATE);

        if (!farmData.name || !farmData.stakingToken?.symbol || !farmData.rewardToken?.symbol || !farmData.rewardToken?.issuer || !farmData.startTime || !farmData.endTime) {
            logger.warn('[farm-create] Invalid data: Missing required fields.');
            return false;
        }

        if (!validate.string(farmData.name, 100, 3)) {
            logger.warn(`[farm-create] Invalid farm name: ${farmData.name}.`);
            return false;
        }

        if (!validate.string(farmData.stakingToken.symbol, 60, 3)) {
            logger.warn(`[farm-create] Invalid stakingToken.symbol: ${farmData.stakingToken.symbol}.`);
            return false;
        }
        // stakingToken.issuer can be optional (e.g. for native pool LP tokens)
        if (farmData.stakingToken.issuer && !validate.string(farmData.stakingToken.issuer, 100, 3)) {
            logger.warn(`[farm-create] Invalid stakingToken.issuer: ${farmData.stakingToken.issuer}.`);
            return false;
        }

        if (!validate.string(farmData.rewardToken.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[farm-create] Invalid rewardToken.symbol: ${farmData.rewardToken.symbol}.`);
            return false;
        }
        if (!validate.string(farmData.rewardToken.issuer, 16, 3)) { // Assuming issuer is an account name
            logger.warn(`[farm-create] Invalid rewardToken.issuer: ${farmData.rewardToken.issuer}.`);
            return false;
        }

        if (farmData.stakingToken.symbol === farmData.rewardToken.symbol && farmData.stakingToken.issuer === farmData.rewardToken.issuer) {
            logger.warn('[farm-create] Staking token and reward token cannot be the same.');
            return false;
        }

        const rewardTokenDoc = await cache.findOnePromise('tokens', { symbol: farmData.rewardToken.symbol /*, issuer: farmData.rewardToken.issuer */ });
        if (!rewardTokenDoc) {
            logger.warn(`[farm-create] Reward Token (${farmData.rewardToken.symbol}) not found.`);
            return false;
        }

        const farmId = generateFarmId(farmData.stakingToken.symbol, farmData.rewardToken.symbol, farmData.rewardToken.issuer);
        const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
        if (existingFarm) {
            logger.warn(`[farm-create] Farm with ID ${farmId} already exists.`);
            return false;
        }
        
        // Assuming startTime and endTime are ISO strings, validate their format and logical order
        if (!validate.string(farmData.startTime, 50, 10) || !validate.string(farmData.endTime, 50, 10)) { // Basic string check
            logger.warn('[farm-create] Invalid startTime or endTime format.');
            return false;
        }
        try {
            if (new Date(farmData.startTime) >= new Date(farmData.endTime)) {
                logger.warn('[farm-create] startTime must be before endTime.');
                return false;
            }
        } catch (e) {
            logger.warn('[farm-create] Invalid date string for startTime or endTime.');
            return false;
        }

        if (!validate.bigint(farmData.totalRewards, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] totalRewards must be a positive integer.');
            return false;
        }
        if (!validate.bigint(farmData.rewardsPerBlock, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] rewardsPerBlock must be a positive integer.');
            return false;
        }
        if (farmData.minStakeAmount !== undefined && !validate.bigint(farmData.minStakeAmount, true, false, undefined, BigInt(0))) {
            logger.warn('[farm-create] minStakeAmount must be a non-negative integer if provided.');
            return false;
        }
        if (farmData.maxStakeAmount !== undefined && !validate.bigint(farmData.maxStakeAmount, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] maxStakeAmount must be a positive integer if provided.');
            return false;
        }
        if (farmData.maxStakeAmount && farmData.minStakeAmount && farmData.maxStakeAmount < farmData.minStakeAmount) {
            logger.warn('[farm-create] maxStakeAmount cannot be less than minStakeAmount.');
            return false;
        }

        const senderAccount = await getAccount(sender);
        if (!senderAccount || !senderAccount.balances || BigIntMath.toBigInt(senderAccount.balances[farmData.rewardToken.symbol] || '0') < farmData.totalRewards) {
            logger.warn(`[farm-create] Sender ${sender} does not have enough ${farmData.rewardToken.symbol} to fund the farm. Needs ${farmData.totalRewards}, has ${senderAccount?.balances?.[farmData.rewardToken.symbol] || '0'}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error validating farm creation: ${error}`);
        return false;
    }
}

export async function process(sender: string, data: FarmCreateDataDB): Promise<boolean> {
    try {
        const farmData = convertToBigInt<FarmCreateData>(data, NUMERIC_FIELDS_FARM_CREATE);
        const farmId = generateFarmId(farmData.stakingToken.symbol, farmData.rewardToken.symbol, farmData.rewardToken.issuer);

        const senderBalanceKey = `balances.${farmData.rewardToken.symbol}`;
        const senderAccount = await getAccount(sender); // Already fetched in validateTx, but re-fetch for atomicity is safer
        if (!senderAccount || !senderAccount.balances) {
            logger.error(`[farm-create] Critical: Sender account or balances not found for ${sender} during processing.`);
            return false; 
        }
        const currentSenderRewardBalance = BigIntMath.toBigInt(senderAccount.balances[farmData.rewardToken.symbol] || '0');
        const newSenderRewardBalance = currentSenderRewardBalance - farmData.totalRewards;

        if (newSenderRewardBalance < BigInt(0)) {
            logger.error(`[farm-create] Critical: Sender ${sender} insufficient balance for ${farmData.rewardToken.symbol} during processing.`);
            return false;
        }

        const updateSenderBalanceSuccess = await cache.updateOnePromise(
            'accounts',
            { name: sender },
            { $set: { [senderBalanceKey]: toString(newSenderRewardBalance) } }
        );

        if (!updateSenderBalanceSuccess) {
            logger.error(`[farm-create] Failed to deduct reward tokens from ${sender}.`);
            return false;
        }

        const farmDocument: Farm = {
            _id: farmId,
            name: farmData.name,
            stakingToken: farmData.stakingToken,
            rewardToken: farmData.rewardToken,
            startTime: farmData.startTime,
            endTime: farmData.endTime,
            totalRewards: farmData.totalRewards,
            rewardsPerBlock: farmData.rewardsPerBlock,
            minStakeAmount: farmData.minStakeAmount === undefined ? BigInt(0) : farmData.minStakeAmount, // Default to 0 if undefined
            maxStakeAmount: farmData.maxStakeAmount === undefined ? BigInt(0) : farmData.maxStakeAmount, // Default to 0 (no limit) or specific large if undefined
            totalStaked: BigInt(0),
            status: 'active',
            createdAt: new Date().toISOString(),
        };

        const farmDocumentDB = convertToString<Farm>(farmDocument, NUMERIC_FIELDS_FARM);
        const insertSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('farms', farmDocumentDB, (err, result) => { // Reverted to cache.insertOne with callback
                if (err || !result) {
                    logger.error(`[farm-create] Failed to insert farm ${farmId} into cache: ${err || 'no result'}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
        
        if (!insertSuccess) {
            logger.error(`[farm-create] Failed to insert farm ${farmId}. Attempting to roll back sender balance.`);
            await cache.updateOnePromise(
                'accounts',
                { name: sender },
                { $set: { [senderBalanceKey]: toString(currentSenderRewardBalance) } }
            );
            return false;
        }

        logger.debug(`[farm-create] Farm ${farmId} for staking token ${farmData.stakingToken.symbol} rewarding ${farmData.rewardToken.symbol} created by ${sender}.`);

        const eventDocument = {
            type: 'farmCreate',
            actor: sender,
            data: {
                farmId: farmId,
                name: farmData.name,
                stakingTokenSymbol: farmData.stakingToken.symbol,
                stakingTokenIssuer: farmData.stakingToken.issuer,
                rewardTokenSymbol: farmData.rewardToken.symbol,
                rewardTokenIssuer: farmData.rewardToken.issuer,
                totalRewards: toString(farmData.totalRewards),
                rewardsPerBlock: toString(farmData.rewardsPerBlock),
                startTime: farmData.startTime,
                endTime: farmData.endTime
            }
        };
        await new Promise<void>((resolve) => { // Reverted to cache.insertOne with callback for event
            cache.insertOne('events', eventDocument, (err, result) => {
                if (err || !result) {
                    logger.error(`[farm-create] CRITICAL: Failed to log farmCreate event for ${farmId}: ${err || 'no result'}.`);
                }
                resolve();
            });
        });

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error processing farm creation: ${error}`);
        // Ensure rollback on any general error if balance was deducted
        // This part needs careful consideration of atomicity or compensation logic
        return false;
    }
} 