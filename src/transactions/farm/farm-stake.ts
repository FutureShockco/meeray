import cache from '../../cache.js';
import logger from '../../logger.js';
import { getAccount, adjustUserBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logTransactionEvent } from '../../utils/event-logger.js';
import validate from '../../validation/index.js';
import { UserLiquidityPositionData } from '../pool/pool-interfaces.js';
import { FarmData, FarmStakeData, UserFarmPositionData } from './farm-interfaces.js';

export async function validateTx(data: FarmStakeData, sender: string): Promise<boolean> {
    try {
        if (!data.farmId || !data.lpTokenAmount) {
            logger.warn('[farm-stake] Invalid data: Missing required fields (farmId, staker, lpTokenAmount).');
            return false;
        }

        if (!validate.string(data.farmId, 64, 1)) {
            logger.warn('[farm-stake] Invalid farmId format.');
            return false;
        }

        if (!validate.bigint(data.lpTokenAmount, false, false, toBigInt(1))) {
            logger.warn('[farm-stake] lpTokenAmount must be a positive number.');
            return false;
        }

        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData;
        if (!farm) {
            logger.warn(`[farm-stake] Farm ${data.farmId} not found.`);
            return false;
        }

        if (farm.status !== 'active') {
            logger.warn(`[farm-stake] Farm ${data.farmId} is not active.`);
            return false;
        }

        const stakingSymbol = farm.stakingToken?.symbol;
        if (!stakingSymbol) {
            logger.warn(`[farm-stake] Farm ${data.farmId} missing staking token symbol.`);
            return false;
        }

        // If staking token is an LP token (prefix LP_), validate against userLiquidityPositions
        if (stakingSymbol.startsWith('LP_')) {
            // Derive poolId from LP token symbol (LP_tokenA_tokenB -> tokenA_tokenB sorted)
            const parts = stakingSymbol.replace(/^LP_/, '').split('_');
            const poolIdForLp = [parts[0], parts[1]].sort().join('_');
            const userLpPositionId = `${sender}_${poolIdForLp}`;
            const userLiquidityPosDB = (await cache.findOnePromise('userLiquidityPositions', {
                _id: userLpPositionId,
            })) as UserLiquidityPositionData | null;

            if (!userLiquidityPosDB || toBigInt(userLiquidityPosDB.lpTokenBalance) < toBigInt(data.lpTokenAmount)) {
                logger.warn(
                    `[farm-stake] Staker ${sender} has insufficient LP token balance for pool ${poolIdForLp} (LP tokens for farm ${data.farmId}). Has ${userLiquidityPosDB?.lpTokenBalance || 0n}, needs ${data.lpTokenAmount}`
                );
                return false;
            }
        } else {
            // Non-LP staking token: check user's account balance for the staking token symbol
            const stakerAccount = await getAccount(sender);
            if (!stakerAccount) {
                logger.warn(`[farm-stake] Staker account ${sender} not found.`);
                return false;
            }
            const userBalance = toBigInt(stakerAccount.balances?.[stakingSymbol] || '0');
            if (userBalance < toBigInt(data.lpTokenAmount)) {
                logger.warn(
                    `[farm-stake] Staker ${sender} has insufficient ${stakingSymbol} balance (has ${stakerAccount.balances?.[stakingSymbol] || '0'}, needs ${data.lpTokenAmount}) for farm ${data.farmId}`
                );
                return false;
            }
        }

        return true;
    } catch (error) {
        logger.error(`[farm-stake] Error validating stake data for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}

export async function processTx(data: FarmStakeData, sender: string, id: string, ts?: number): Promise<boolean> {
    try {
        const farm = (await cache.findOnePromise('farms', { _id: data.farmId })) as FarmData | null;
        // Validate farm timing and status using tx timestamp if provided
        const nowMs = ts ?? Date.now();
        if (!farm) return false;
        const farmStart = new Date(farm.startTime).getTime();
        const farmEnd = new Date(farm.endTime).getTime();
        if (farm.status !== 'active' || nowMs < farmStart || nowMs > farmEnd) {
            logger.warn(`[farm-stake] Farm ${data.farmId} not active at ts=${nowMs}.`);
            return false;
        }

        // Enforce min/max stake constraints if set (0 means unlimited)
        const minStake = toBigInt((farm as any).minStakeAmount || '0');
        // const maxStake = toBigInt((farm as any).maxStakeAmount || '0');
        if (minStake > toBigInt(0) && toBigInt(data.lpTokenAmount) < minStake) {
            logger.warn(`[farm-stake] Amount below minStakeAmount for farm ${data.farmId}.`);
            return false;
        }
        const stakingSymbol = farm.stakingToken?.symbol;
        if (!stakingSymbol) {
            logger.error(`[farm-stake] Critical: Farm ${data.farmId} missing staking token symbol during processing.`);
            return false;
        }

        if (stakingSymbol.startsWith('LP_')) {
            // LP staking: derive poolId from LP token symbol
            const parts = stakingSymbol.replace(/^LP_/, '').split('_');
            const poolIdForLp = [parts[0], parts[1]].sort().join('_');
            const userLpSourcePositionId = `${sender}_${poolIdForLp}`;
            const userLiquidityPosDB = (await cache.findOnePromise('userLiquidityPositions', {
                _id: userLpSourcePositionId,
            })) as UserLiquidityPositionData | null;

            if (!userLiquidityPosDB || toBigInt(userLiquidityPosDB.lpTokenBalance) < toBigInt(data.lpTokenAmount)) {
                logger.error(`[farm-stake] CRITICAL: Staker ${sender} has insufficient LP balance for ${poolIdForLp} during processing.`);
                return false;
            }

            // 1. Decrease LP token balance from UserLiquidityPosition
            const newLpBalanceInPool = toBigInt(userLiquidityPosDB.lpTokenBalance) - toBigInt(data.lpTokenAmount);
            await cache.updateOnePromise(
                'userLiquidityPositions',
                { _id: userLpSourcePositionId },
                {
                    $set: { lpTokenBalance: toDbString(newLpBalanceInPool) },
                    lastUpdatedAt: new Date().toISOString(),
                }
            );
        } else {
            // Non-LP staking: debit user's account balance for the staking token symbol
            const debitSuccess = await adjustUserBalance(sender, stakingSymbol, -toBigInt(data.lpTokenAmount));
            if (!debitSuccess) {
                logger.error(`[farm-stake] CRITICAL: Failed to debit ${stakingSymbol} from ${sender} during staking.`);
                return false;
            }
        }

        // 2. Increase totalLpStaked in the Farm document
        const currentFarm = await cache.findOnePromise('farms', { _id: data.farmId });
        const currentTotalStaked = toBigInt(currentFarm?.totalStaked || '0');
        const newTotalStaked = currentTotalStaked + toBigInt(data.lpTokenAmount);

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

        // 3. Create or update UserFarmPosition
        const userFarmPositionId = `${sender}_${data.farmId}`;

        const existingUserFarmPosDB = (await cache.findOnePromise('userFarmPositions', {
            _id: userFarmPositionId,
        })) as UserFarmPositionData | null;
        const existingUserFarmPos = existingUserFarmPosDB;

        if (existingUserFarmPos) {
            // Update existing position
            await cache.updateOnePromise(
                'userFarmPositions',
                { _id: userFarmPositionId },
                {
                    $set: {
                        stakedAmount: toDbString(toBigInt(existingUserFarmPos.stakedAmount) + toBigInt(data.lpTokenAmount)),
                        lastUpdatedAt: new Date().toISOString(),
                    },
                }
            );
        } else {
            // Create new position
            const newUserFarmPosition: UserFarmPositionData = {
                _id: userFarmPositionId,
                userId: sender,
                farmId: data.farmId,
                stakedAmount: toDbString(data.lpTokenAmount),
                pendingRewards: toDbString(0n),
                lastHarvestTime: new Date(nowMs).toISOString(),
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

        const poolIdOrSymbol = stakingSymbol.startsWith('LP_') ? (() => {
            const parts = stakingSymbol.replace(/^LP_/, '').split('_');
            return [parts[0], parts[1]].sort().join('_');
        })() : stakingSymbol;

        logger.debug(`[farm-stake] Staker ${sender} staked ${data.lpTokenAmount} of ${stakingSymbol} into farm ${data.farmId}.`);

        // Log event
        await logTransactionEvent('farm_stake', sender, {
            farmId: data.farmId,
            staker: sender,
            lpTokenAmount: toDbString(data.lpTokenAmount),
            poolId: poolIdOrSymbol,
            totalStaked: toDbString(newTotalStaked),
        });

        return true;
    } catch (error) {
        logger.error(`[farm-stake] Error processing stake for farm ${data.farmId} by ${sender}: ${error}`);
        return false;
    }
}
