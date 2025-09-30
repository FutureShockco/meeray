import cache from '../../cache.js';
import chain from '../../chain.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { getAccount, adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { FarmData, FarmStakeData, UserFarmPositionData } from './farm-interfaces.js';

export async function validateTx(data: FarmStakeData, sender: string): Promise<boolean> {
    try {
        if (!data.farmId || !data.tokenAmount) {
            logger.warn('[farm-stake] Invalid data: Missing required fields (farmId, tokenAmount).');
            return false;
        }

        if (!validate.string(data.farmId, 96, 1)) {
            logger.warn('[farm-stake] Invalid farmId format.');
            return false;
        }

        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData;
        if (!farm) {
            logger.warn(`[farm-stake] Farm ${data.farmId} not found.`);
            return false;
        }

        if (farm.status !== 'active' ) {
            logger.warn(`[farm-stake] Farm ${data.farmId} is not active.`);
            return false;
        }

        if (!validate.bigint(data.tokenAmount, false, false, toBigInt(farm.minStakeAmount || '1'), toBigInt(farm.maxStakeAmount || config.maxValue))) {
            logger.warn('[farm-stake] tokenAmount must be a positive number.');
            return false;
        }

        const stakingSymbol = farm.stakingToken;
        if (!stakingSymbol) {
            logger.warn(`[farm-stake] Farm ${data.farmId} missing staking token symbol.`);
            return false;
        }

        if(!await validate.userBalances(sender, [{ symbol: stakingSymbol, amount: toBigInt(data.tokenAmount) }])) {
            logger.warn(`[farm-stake] Staker ${sender} has insufficient balance of ${stakingSymbol}.`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-stake] Error validating stake data for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmStakeData, sender: string, id: string, ts?: number): Promise<boolean> {
    try {
        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData;
        const stakingSymbol = farm.stakingToken;
        const currentBlockNum = chain.getLatestBlock().id;

        const debitSender = await adjustUserBalance(sender, stakingSymbol, -toBigInt(data.tokenAmount));
        if (!debitSender) {
            logger.error(`[token-transfer:process] Failed to debit sender ${sender} for ${toBigInt(data.tokenAmount).toString()} ${stakingSymbol}`);
            return false;
        }
            const userPositions = (await cache.findPromise('userFarmPositions', { farmId: data.farmId }) as UserFarmPositionData[]) || [];
            for (const userPos of userPositions) {
                // Calculate pending rewards for user up to currentBlockNum
                const blocksElapsed = BigInt(Math.max(0, currentBlockNum - Number(userPos.lastHarvestBlock)));
                const rewardsPerBlock = toBigInt(farm.rewardsPerBlock || '0');
                const totalStaked = toBigInt(farm.totalStaked || '0');
                const stakedAmount = toBigInt(userPos.stakedAmount || '0');
                let pendingRewards = (rewardsPerBlock * blocksElapsed * stakedAmount) / (totalStaked === 0n ? 1n : totalStaked);

                // Add to user's pendingRewards and update lastHarvestBlock
                await cache.updateOnePromise(
                    'userFarmPositions',
                    { _id: userPos._id },
                    {
                        $set: {
                            pendingRewards: toDbString(toBigInt(userPos.pendingRewards || '0') + pendingRewards),
                            lastHarvestBlock: currentBlockNum,
                            lastUpdatedAt: new Date().toISOString(),
                        },
                    }
                );
            }
        const currentTotalStaked = toBigInt(farm.totalStaked || '0');
        const newTotalStaked = toBigInt(currentTotalStaked) + toBigInt(data.tokenAmount);
        await cache.updateOnePromise(
            'farms',
            { _id: data.farmId },
            {
                $set: {
                    totalStaked: toDbString(newTotalStaked),
                    lastUpdatedBlock: currentBlockNum,
                },
            }
        );
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const existingUserFarmPos = (await cache.findOnePromise('userFarmPositions', {
            _id: userFarmPositionId,
        })) as UserFarmPositionData | null;

        if (existingUserFarmPos) {
            await cache.updateOnePromise(
                'userFarmPositions',
                { _id: userFarmPositionId },
                {
                    $set: {
                        stakedAmount: toDbString(toBigInt(existingUserFarmPos.stakedAmount) + toBigInt(data.tokenAmount)),
                        lastHarvestBlock: currentBlockNum,
                    },
                }
            );
        } else {
            const newUserFarmPosition: UserFarmPositionData = {
                _id: userFarmPositionId,
                userId: sender,
                farmId: data.farmId,
                stakedAmount: toDbString(toBigInt(data.tokenAmount)),
                pendingRewards: toDbString(0n),
                lastHarvestBlock: currentBlockNum,
                createdAt: new Date().toISOString(),
                lastUpdatedAt: new Date().toISOString(),
            };

            await new Promise<boolean>(resolve => {
                cache.insertOne('userFarmPositions', newUserFarmPosition, (err, success) => {
                    if (err || !success) {
                        logger.error(`[farm-stake] System error: Failed to insert user farm position ${userFarmPositionId}: ${err || 'insert not successful'}`);
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                });
            });
        }

        await logTransactionEvent('farm_stake', sender, {
            farmId: data.farmId,
            staker: sender,
            tokenAmount: toDbString(data.tokenAmount),
            poolId: farm._id,
            totalStaked: toDbString(newTotalStaked),
        });

        return true;
    } catch (error) {
        logger.error(`[farm-stake] Error processing stake for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}
