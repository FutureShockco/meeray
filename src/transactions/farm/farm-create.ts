import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import config from '../../config.js';
import { FarmCreateData, FarmData } from './farm-interfaces.js';
import { convertToBigInt, convertToString, toDbString, BigIntMath } from '../../utils/bigint.js';
import { getAccount } from '../../utils/account.js';

const NUMERIC_FIELDS_FARM_CREATE: Array<keyof FarmCreateData> = ['totalRewards', 'rewardsPerBlock', 'minStakeAmount', 'maxStakeAmount'];
const NUMERIC_FIELDS_FARM: Array<keyof FarmData> = ['totalRewards', 'rewardsPerBlock', 'minStakeAmount', 'maxStakeAmount', 'totalStaked'];

// Helper function to generate a unique and deterministic farm ID
function generateFarmId(stakingTokenSymbol: string, rewardTokenSymbol: string, rewardTokenIssuer: string): string {
    // Consider a more robust ID generation, e.g., crypto hash if needed for global uniqueness
    return `FARM_${stakingTokenSymbol}_${rewardTokenSymbol}_${rewardTokenIssuer}`.toUpperCase();
}

export async function validateTx(data: FarmCreateData, sender: string): Promise<boolean> {
    try {
        if (!data.name || !data.stakingToken?.symbol || !data.rewardToken?.symbol || !data.rewardToken?.issuer || !data.startTime || !data.endTime) {
            logger.warn('[farm-create] Invalid data: Missing required fields.');
            return false;
        }

        if (!validate.string(data.name, 100, 3)) {
            logger.warn(`[farm-create] Invalid farm name: ${data.name}.`);
            return false;
        }

        if (!validate.string(data.stakingToken.symbol, 60, 3)) {
            logger.warn(`[farm-create] Invalid stakingToken.symbol: ${data.stakingToken.symbol}.`);
            return false;
        }
        // stakingToken.issuer can be optional (e.g. for native pool LP tokens)
        if (data.stakingToken.issuer && !validate.string(data.stakingToken.issuer, 100, 3)) {
            logger.warn(`[farm-create] Invalid stakingToken.issuer: ${data.stakingToken.issuer}.`);
            return false;
        }

        if (!validate.string(data.rewardToken.symbol, 10, 3, config.tokenSymbolAllowedChars)) {
            logger.warn(`[farm-create] Invalid rewardToken.symbol: ${data.rewardToken.symbol}.`);
            return false;
        }
        if (!validate.string(data.rewardToken.issuer, 16, 3)) { // Assuming issuer is an account name
            logger.warn(`[farm-create] Invalid rewardToken.issuer: ${data.rewardToken.issuer}.`);
            return false;
        }

        if (data.stakingToken.symbol === data.rewardToken.symbol && data.stakingToken.issuer === data.rewardToken.issuer) {
            logger.warn('[farm-create] Staking token and reward token cannot be the same.');
            return false;
        }

        const rewardTokenDoc = await cache.findOnePromise('tokens', { symbol: data.rewardToken.symbol /*, issuer: data.rewardToken.issuer */ });
        if (!rewardTokenDoc) {
            logger.warn(`[farm-create] Reward Token (${data.rewardToken.symbol}) not found.`);
            return false;
        }

        const farmId = generateFarmId(data.stakingToken.symbol, data.rewardToken.symbol, data.rewardToken.issuer);
        const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
        if (existingFarm) {
            logger.warn(`[farm-create] Farm with ID ${farmId} already exists.`);
            return false;
        }
        
        // Assuming startTime and endTime are ISO strings, validate their format and logical order
        if (!validate.string(data.startTime, 50, 10) || !validate.string(data.endTime, 50, 10)) { // Basic string check
            logger.warn('[farm-create] Invalid startTime or endTime format.');
            return false;
        }
        try {
            if (new Date(data.startTime) >= new Date(data.endTime)) {
                logger.warn('[farm-create] startTime must be before endTime.');
                return false;
            }
        } catch (e) {
            logger.warn('[farm-create] Invalid date string for startTime or endTime.');
            return false;
        }

        if (!validate.bigint(data.totalRewards, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] totalRewards must be a positive integer.');
            return false;
        }
        if (!validate.bigint(data.rewardsPerBlock, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] rewardsPerBlock must be a positive integer.');
            return false;
        }
        if (data.minStakeAmount !== undefined && !validate.bigint(data.minStakeAmount, true, false, undefined, BigInt(0))) {
            logger.warn('[farm-create] minStakeAmount must be a non-negative integer if provided.');
            return false;
        }
        if (data.maxStakeAmount !== undefined && !validate.bigint(data.maxStakeAmount, false, false, undefined, BigInt(1))) {
            logger.warn('[farm-create] maxStakeAmount must be a positive integer if provided.');
            return false;
        }
        if (data.maxStakeAmount && data.minStakeAmount && data.maxStakeAmount < data.minStakeAmount) {
            logger.warn('[farm-create] maxStakeAmount cannot be less than minStakeAmount.');
            return false;
        }

        const senderAccount = await getAccount(sender);
        if (!senderAccount || !senderAccount.balances || BigIntMath.toBigInt(senderAccount.balances[data.rewardToken.symbol] || '0') < BigInt(data.totalRewards)) {
            logger.warn(`[farm-create] Sender ${sender} does not have enough ${data.rewardToken.symbol} to fund the farm. Needs ${data.totalRewards}, has ${senderAccount?.balances?.[data.rewardToken.symbol] || '0'}`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error validating farm creation: ${error}`);
        return false;
    }
}

export async function process(data: FarmCreateData, sender: string, id: string): Promise<boolean> {
    try {
        const farmData = convertToBigInt<FarmCreateData>(data, NUMERIC_FIELDS_FARM_CREATE);
        const farmId = generateFarmId(farmData.stakingToken.symbol, farmData.rewardToken.symbol, farmData.rewardToken.issuer);

        const senderBalanceKey = `balances.${farmData.rewardToken.symbol}`;
        const senderAccount = await getAccount(sender); 
        if (!senderAccount || !senderAccount.balances) {
            logger.error(`[farm-create] Critical: Sender account or balances not found for ${sender} during processing.`);
            return false; 
        }
        const currentSenderRewardBalance = BigIntMath.toBigInt(senderAccount.balances[farmData.rewardToken.symbol] || '0');
        const newSenderRewardBalance = currentSenderRewardBalance - BigInt(farmData.totalRewards);

        if (newSenderRewardBalance < BigInt(0)) {
            logger.error(`[farm-create] Critical: Sender ${sender} insufficient balance for ${farmData.rewardToken.symbol} during processing.`);
            return false;
        }

        await cache.updateOnePromise(
            'accounts',
            { name: sender },
            { $set: { [senderBalanceKey]: toDbString(newSenderRewardBalance) } }
        );

        const farmDocument: FarmData = {
            _id: farmId,
            name: farmData.name,
            stakingToken: farmData.stakingToken,
            rewardToken: farmData.rewardToken,
            startTime: farmData.startTime,
            endTime: farmData.endTime,
            totalRewards: farmData.totalRewards,
            rewardsPerBlock: farmData.rewardsPerBlock,
            minStakeAmount: farmData.minStakeAmount === undefined ? BigInt(0) : farmData.minStakeAmount, 
            maxStakeAmount: farmData.maxStakeAmount === undefined ? BigInt(0) : farmData.maxStakeAmount, 
            totalStaked: BigInt(0),
            status: 'active',
            createdAt: new Date().toISOString(),
        };

        const farmDocumentDB = convertToString<FarmData>(farmDocument, NUMERIC_FIELDS_FARM);
        const insertSuccess = await new Promise<boolean>((resolve) => {
            cache.insertOne('farms', farmDocumentDB, (err, result) => { 
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

        logger.debug(`[farm-create] Farm ${farmId} for staking token ${farmData.stakingToken.symbol} rewarding ${farmData.rewardToken.symbol} created by ${sender}.`);

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error processing farm creation: ${error}`);
        return false;
    }
} 