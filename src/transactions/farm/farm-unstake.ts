import cache from '../../cache.js';
import logger from '../../logger.js';
import { getAccount } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { FarmData, FarmUnstakeData, UserFarmPositionData } from './farm-interfaces.js';

export async function validateTx(data: FarmUnstakeData, sender: string): Promise<boolean> {
    try {
        // Check required fields
        if (!data.farmId || !data.tokenAmount) {
            logger.warn('[farm-unstake] Missing required fields (farmId, tokenAmount).');
            return false;
        }

        // Validate farmId format
        if (!validate.string(data.farmId, 64, 1)) {
            logger.warn('[farm-unstake] Invalid farmId format.');
            return false;
        }

        // Validate amount
        if (!validate.bigint(data.tokenAmount, false, false, toBigInt(1))) {
            logger.warn('[farm-unstake] tokenAmount must be a positive number.');
            return false;
        }

        // Check farm existence and status
        const farm = await cache.findOnePromise('farms', { _id: data.farmId }) as FarmData | null;
        if (!farm) {
            logger.warn(`[farm-unstake] Farm ${data.farmId} not found.`);
            return false;
        }
        if (farm.status !== 'active') {
            logger.warn(`[farm-unstake] Farm ${data.farmId} is not active.`);
            return false;
        }

        // Check user farm position and staked amount
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const userFarmPos = await cache.findOnePromise('userFarmPositions', { _id: userFarmPositionId }) as UserFarmPositionData | null;
        if (!userFarmPos || toBigInt(userFarmPos.stakedAmount) < toBigInt(data.tokenAmount)) {
            logger.warn(`[farm-unstake] Insufficient staked amount for user ${sender} in farm ${data.farmId}.`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`[farm-unstake] Error validating unstake data for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmUnstakeData, sender: string, id: string, ts?: number): Promise<boolean> {
    try {
        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData;
        const stakingSymbol = farm.stakingToken;
        const tokenAmount = toBigInt(data.tokenAmount);

        // Decrease staked amount in UserFarmPosition
        const userFarmPositionId = `${sender}_${data.farmId}`;
        const userFarmPos = (await cache.findOnePromise('userFarmPositions', {
            _id: userFarmPositionId,
        })) as UserFarmPositionData;

        const newStakedAmount = toBigInt(userFarmPos.stakedAmount) - tokenAmount;
        await cache.updateOnePromise(
            'userFarmPositions',
            { _id: userFarmPositionId },
            {
                $set: {
                    stakedAmount: toDbString(newStakedAmount),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );

        // Decrease totalStaked in Farm document
        const currentTotalStaked = toBigInt(farm.totalStaked || '0');
        const newTotalStaked = currentTotalStaked - tokenAmount;

        await cache.updateOnePromise(
            'farms',
            { _id: data.farmId },
            {
                $set: {
                    totalStaked: toDbString(newTotalStaked),
                    lastUpdatedAt: new Date().toISOString(),
                },
            }
        );

        // Return LP tokens to user's liquidity position if LP token, else credit staking token
        if (stakingSymbol.startsWith('LP_')) {
            const parts = stakingSymbol.replace(/^LP_/, '').split('_');
            const poolIdForLp = [parts[0], parts[1]].sort().join('_');
            const userLpDestinationPositionId = `${sender}_${poolIdForLp}`;

            const existingUserLiquidityPos = (await cache.findOnePromise('userLiquidityPositions', {
                _id: userLpDestinationPositionId,
            })) as UserLiquidityPositionData | null;

            if (existingUserLiquidityPos) {
                await cache.updateOnePromise(
                    'userLiquidityPositions',
                    { _id: userLpDestinationPositionId },
                    {
                        $set: {
                            lpTokenBalance: toDbString(toBigInt(existingUserLiquidityPos.lpTokenBalance) + tokenAmount),
                            lastUpdatedAt: new Date().toISOString(),
                        },
                    }
                );
            } else {
                const newUserLiquidityPos: UserLiquidityPositionData = {
                    _id: userLpDestinationPositionId,
                    user: sender,
                    poolId: poolIdForLp,
                    lpTokenBalance: toDbString(tokenAmount),
                    createdAt: new Date().toISOString(),
                    lastUpdatedAt: new Date().toISOString(),
                };

                await new Promise<boolean>(resolve => {
                    cache.insertOne('userLiquidityPositions', newUserLiquidityPos, (err, success) => {
                        if (err || !success) {
                            logger.error(
                                `[farm-unstake] System error: Failed to insert new user liquidity position ${userLpDestinationPositionId}: ${err || 'insert not successful'}`
                            );
                            resolve(false);
                        } else {
                            resolve(true);
                        }
                    });
                });
            }
        } else {
            // Non-LP staking: credit user's account balance for the staking token symbol
            await cache.updateOnePromise(
                'accounts',
                { name: sender },
                {
                    $inc: { [`balances.${stakingSymbol}`]: tokenAmount.toString() },
                    $set: { lastUpdatedAt: new Date().toISOString() },
                }
            );
        }

        logger.debug(`[farm-unstake] Staker ${sender} unstaked ${data.tokenAmount} ${stakingSymbol} from farm ${data.farmId}.`);

        // Log event
        await logTransactionEvent('farm_unstake', sender, {
            farmId: data.farmId,
            staker: sender,
            tokenAmount: toDbString(data.tokenAmount),
            poolId: stakingSymbol.startsWith('LP_') ? (() => {
                const parts = stakingSymbol.replace(/^LP_/, '').split('_');
                return [parts[0], parts[1]].sort().join('_');
            })() : stakingSymbol,
            totalStaked: toDbString(newTotalStaked),
        });

        return true;
    } catch (error) {
        logger.error(`[farm-unstake] Error processing unstake for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}
