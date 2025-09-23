import cache from '../../cache.js';
import config from '../../config.js';
import logger from '../../logger.js';
import mongo from '../../mongo.js';
import { getAccount } from '../../utils/account.js';
import { BigIntMath, toBigInt, toDbString } from '../../utils/bigint.js';
import validate from '../../validation/index.js';
import { FarmCreateData, FarmData } from './farm-interfaces.js';

// Helper function to generate a unique and deterministic farm ID
function generateFarmId(stakingTokenSymbol: string, rewardTokenSymbol: string): string {
    // Consider a more robust ID generation, e.g., crypto hash if needed for global uniqueness
    return `FARM_${stakingTokenSymbol}_${rewardTokenSymbol}`.toUpperCase();
}

export async function validateTx(data: FarmCreateData, sender: string): Promise<boolean> {
    try {
        if (
            !data.name ||
            !data.stakingToken?.symbol ||
            !data.rewardToken?.symbol ||
            !data.rewardToken?.issuer ||
            !data.startTime ||
            !data.endTime
        ) {
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
        if (!validate.string(data.rewardToken.issuer, 16, 3)) {
            // Assuming issuer is an account name
            logger.warn(`[farm-create] Invalid rewardToken.issuer: ${data.rewardToken.issuer}.`);
            return false;
        }

        // Validate weight (optional, default to 1 for native farms, 0 for custom farms)
        if (data.weight !== undefined && !validate.integer(data.weight, true, false, 1000, 0)) {
            logger.warn(`[farm-create] Invalid weight: ${data.weight}. Must be between 0-1000.`);
            return false;
        }

        const rewardToken = await cache.findOnePromise('tokens', { symbol: data.rewardToken.symbol });
        if (!rewardToken) {
            logger.warn(`[farm-create] Reward Token (${data.rewardToken.symbol}) not found.`);
            return false;
        }

        // Validate that the sender is the issuer of the reward token
        if (rewardToken.issuer !== sender) {
            logger.warn(
                `[farm-create] Sender ${sender} is not the issuer of reward token ${data.rewardToken.symbol}. Token issuer: ${rewardToken.issuer}`
            );
            return false;
        }

        // Validate that the reward token is mintable
        if (!rewardToken.mintable) {
            logger.warn(
                `[farm-create] Reward token ${data.rewardToken.symbol} is not mintable. Cannot create farm with non-mintable reward token.`
            );
            return false;
        }

        const farmId = generateFarmId(data.stakingToken.symbol, data.rewardToken.symbol);
        const existingFarm = await cache.findOnePromise('farms', { _id: farmId });
        if (existingFarm) {
            logger.warn(`[farm-create] Farm with ID ${farmId} already exists.`);
            return false;
        }

        // Assuming startTime and endTime are ISO strings, validate their format and logical order
        if (!validate.string(data.startTime, 50, 10) || !validate.string(data.endTime, 50, 10)) {
            // Basic string check
            logger.warn('[farm-create] Invalid startTime or endTime format.');
            return false;
        }
        try {
            if (new Date(data.startTime) >= new Date(data.endTime)) {
                logger.warn('[farm-create] startTime must be before endTime.');
                return false;
            }
        } catch {
            logger.warn('[farm-create] Invalid date string for startTime or endTime.');
            return false;
        }

        if (!validate.bigint(data.totalRewards, false, false, toBigInt(1))) {
            logger.warn('[farm-create] totalRewards must be a positive integer.');
            return false;
        }
        if (!validate.bigint(data.rewardsPerBlock, false, false, toBigInt(1))) {
            logger.warn('[farm-create] rewardsPerBlock must be a positive integer.');
            return false;
        }
        if (data.minStakeAmount !== undefined && !validate.bigint(data.minStakeAmount, true, false, toBigInt(0))) {
            logger.warn('[farm-create] minStakeAmount must be a non-negative integer if provided.');
            return false;
        }
        if (data.maxStakeAmount !== undefined && !validate.bigint(data.maxStakeAmount, false, false, toBigInt(1))) {
            logger.warn('[farm-create] maxStakeAmount must be a positive integer if provided.');
            return false;
        }
        if (data.maxStakeAmount && data.minStakeAmount && data.maxStakeAmount < data.minStakeAmount) {
            logger.warn('[farm-create] maxStakeAmount cannot be less than minStakeAmount.');
            return false;
        }

        const senderAccount = await getAccount(sender);
        if (
            !senderAccount ||
            !senderAccount.balances ||
            BigIntMath.toBigInt(senderAccount.balances[data.rewardToken.symbol] || '0') < toBigInt(data.totalRewards)
        ) {
            logger.warn(
                `[farm-create] Sender ${sender} does not have enough ${data.rewardToken.symbol} to fund the farm. Needs ${data.totalRewards}, has ${senderAccount?.balances?.[data.rewardToken.symbol] || '0'}`
            );
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error validating farm creation: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmCreateData, sender: string, _id: string, _ts?: number): Promise<boolean> {
    try {
        const farmId = generateFarmId(data.stakingToken.symbol, data.rewardToken.symbol);

        const senderBalanceKey = `balances.${data.rewardToken.symbol}`;
        const senderAccount = await getAccount(sender);
        if (!senderAccount || !senderAccount.balances) {
            logger.error(`[farm-create] Critical: Sender account or balances not found for ${sender} during processing.`);
            return false;
        }
        const currentSenderRewardBalance = BigIntMath.toBigInt(senderAccount.balances[data.rewardToken.symbol] || '0');
        const newSenderRewardBalance = currentSenderRewardBalance - toBigInt(data.totalRewards);

        if (newSenderRewardBalance < toBigInt(0)) {
            logger.error(
                `[farm-create] Critical: Sender ${sender} insufficient balance for ${data.rewardToken.symbol} during processing.`
            );
            return false;
        }

        await cache.updateOnePromise(
            'accounts',
            { name: sender },
            { $set: { [senderBalanceKey]: toDbString(newSenderRewardBalance) } }
        );

        // Create or upsert a farm vault account to hold rewards
        const vaultAccountName = `farm_vault_${farmId}`;
        const existingVault = await cache.findOnePromise('accounts', { name: vaultAccountName });
        if (!existingVault) {
            await mongo
                .getDb()
                .collection('accounts')
                .updateOne(
                    { name: vaultAccountName },
                    {
                        $setOnInsert: {
                            name: vaultAccountName,
                            balances: { [data.rewardToken.symbol]: toDbString(toBigInt(0)) },
                            nfts: {},
                            totalVoteWeight: toDbString(toBigInt(0)),
                            votedWitnesses: [],
                            created: new Date(),
                        },
                    },
                    { upsert: true }
                );
            const insertedVault = await mongo.getDb().collection('accounts').findOne({ name: vaultAccountName });
            if (insertedVault) {
                cache.accounts[vaultAccountName] = insertedVault as any;
            }
        }
        // Credit vault with the farm rewards
        const vaultBalanceKey = `balances.${data.rewardToken.symbol}`;
        const vaultAccount = await cache.findOnePromise('accounts', { name: vaultAccountName });
        const currentVaultBal = BigIntMath.toBigInt(vaultAccount?.balances?.[data.rewardToken.symbol] || '0');
        const newVaultBal = currentVaultBal + toBigInt(data.totalRewards);
        await cache.updateOnePromise(
            'accounts',
            { name: vaultAccountName },
            { $set: { [vaultBalanceKey]: toDbString(newVaultBal) } }
        );

        // Determine if this is a native farm (rewards in MRY from system)
        const isNativeFarm =
            data.rewardToken.symbol === config.nativeTokenSymbol && data.rewardToken.issuer === config.masterName;

        // Set default weight based on farm type
        const farmWeight = data.weight !== undefined ? data.weight : isNativeFarm ? 1 : 0;

        const farmDocument: FarmData = {
            _id: farmId,
            farmId: farmId,
            name: data.name,
            stakingToken: data.stakingToken,
            rewardToken: data.rewardToken,
            startTime: data.startTime,
            endTime: data.endTime,
            totalRewards: data.totalRewards,
            rewardsPerBlock: data.rewardsPerBlock,
            minStakeAmount: data.minStakeAmount === undefined ? toBigInt(0) : data.minStakeAmount,
            maxStakeAmount: data.maxStakeAmount === undefined ? toBigInt(0) : data.maxStakeAmount,
            totalStaked: toBigInt(0),
            weight: farmWeight,
            isNativeFarm: isNativeFarm,
            isActive: true,
            status: 'active',
            createdAt: new Date().toISOString(),
            rewardsRemaining: toDbString(data.totalRewards),
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

        logger.debug(
            `[farm-create] Farm ${farmId} for staking token ${data.stakingToken.symbol} rewarding ${data.rewardToken.symbol} created by ${sender}.`
        );

        return true;
    } catch (error) {
        logger.error(`[farm-create] Error processing farm creation: ${error}`);
        return false;
    }
}
