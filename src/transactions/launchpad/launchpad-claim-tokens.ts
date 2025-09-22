import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { LaunchpadClaimTokensData, LaunchpadStatus, TokenDistributionRecipient, VestingState } from './launchpad-interfaces.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { logEvent } from '../../utils/event-logger.js';
import { calculateVestedAmount, calculateUserAllocation, parseSteemTimestamp } from '../../utils/vesting.js';

export async function validateTx(data: LaunchpadClaimTokensData, sender: string, blockTimestamp: string): Promise<boolean> {
  logger.debug(`[launchpad-claim-tokens] Validating claim from ${sender} for launchpad ${data.launchpadId}, type ${data.allocationType}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-claim-tokens] Sender must match userId for claiming tokens.');
    return false;
  }

  if (!data.launchpadId || !data.allocationType) {
    logger.warn('[launchpad-claim-tokens] Missing required fields: launchpadId, allocationType.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
  if (!launchpad) {
    logger.warn(`[launchpad-claim-tokens] Launchpad project ${data.launchpadId} not found.`);
    return false;
  }

  const claimableStatuses = [
    LaunchpadStatus.PRESALE_SUCCEEDED_HARDCAP_MET, 
    LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET, 
    LaunchpadStatus.TOKEN_GENERATION_EVENT,
    LaunchpadStatus.COMPLETED,
    LaunchpadStatus.TRADING_LIVE
  ];
  
  if (!claimableStatuses.includes(launchpad.status)) {
    logger.warn(`[launchpad-claim-tokens] Launchpad ${data.launchpadId} is not in a claimable status. Current status: ${launchpad.status}`);
    return false;
  }

  if (!launchpad.mainTokenId) {
    logger.warn(`[launchpad-claim-tokens] Main token ID not yet set for launchpad ${data.launchpadId}.`);
    return false;
  }

  // Validate specific allocation types
  if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
    if (!launchpad.presale || !launchpad.presale.participants) {
      logger.warn(`[launchpad-claim-tokens] No presale participant data found for ${data.launchpadId}.`);
      return false;
    }
    const participant = launchpad.presale.participants.find((p: any) => p.userId === data.userId);
    if (!participant) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} not found in presale participants for ${data.launchpadId}.`);
      return false;
    }
  } else if (data.allocationType === TokenDistributionRecipient.AIRDROP_REWARDS) {
    if (!launchpad.airdropRecipients) {
      logger.warn(`[launchpad-claim-tokens] No airdrop recipients found for ${data.launchpadId}.`);
      return false;
    }
    const airdropRecipient = launchpad.airdropRecipients.find((r: any) => r.username === data.userId);
    if (!airdropRecipient) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} not found in airdrop recipients for ${data.launchpadId}.`);
      return false;
    }
    if (airdropRecipient.claimed) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} has already claimed airdrop tokens for ${data.launchpadId}.`);
      return false;
    }
  } else {
    // For other allocations (team, advisors, etc.), check if tokenomics exists and user has permission
    if (!launchpad.tokenomicsSnapshot?.allocations) {
      logger.warn(`[launchpad-claim-tokens] No tokenomics configured for ${data.launchpadId}.`);
      return false;
    }
    
    const allocation = launchpad.tokenomicsSnapshot.allocations.find((a: any) => a.recipient === data.allocationType);
    if (!allocation) {
      logger.warn(`[launchpad-claim-tokens] No allocation found for type ${data.allocationType} in ${data.launchpadId}.`);
      return false;
    }

    // For simplicity, assume project owner can claim team/advisor allocations
    // In production, you'd want more sophisticated access control
    if (sender !== launchpad.launchedByUserId) {
      logger.warn(`[launchpad-claim-tokens] Only project owner can claim ${data.allocationType} tokens.`);
      return false;
    }
  }

  logger.debug('[launchpad-claim-tokens] Validation passed.');
  return true;
}

export async function processTx(data: LaunchpadClaimTokensData, sender: string, transactionId: string, blockTimestamp: string): Promise<boolean> {
  logger.debug(`[launchpad-claim-tokens] Processing claim from ${sender} for ${data.launchpadId}, type ${data.allocationType}`);
  
  try {
    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpad) return false;

    const currentTimestamp = parseSteemTimestamp(blockTimestamp);
    const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId });
    if (!tokenInfo) {
      logger.error(`[launchpad-claim-tokens] Token information for ${launchpad.mainTokenId} not found.`);
      return false;
    }

    let tokensToMint = BigInt(0);
    let updateQuery: any = {};

    if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
      // Handle presale participant claims
      const participant = launchpad.presale.participants.find((p: any) => p.userId === data.userId);
      if (!participant || participant.claimed) {
        logger.error(`[launchpad-claim-tokens] Presale participant ${data.userId} already claimed or not found.`);
        return false;
      }

      tokensToMint = toBigInt(participant.tokensAllocated || '0');
      if (tokensToMint <= BigInt(0)) {
        logger.warn(`[launchpad-claim-tokens] No tokens allocated for presale participant ${data.userId}.`);
        return false;
      }

      // Mark participant as claimed
      const participantIndex = launchpad.presale.participants.findIndex((p: any) => p.userId === data.userId);
      updateQuery[`presale.participants.${participantIndex}.claimed`] = true;

    } else if (data.allocationType === TokenDistributionRecipient.AIRDROP_REWARDS) {
      // Handle airdrop claims (immediate, no vesting)
      const airdropRecipient = launchpad.airdropRecipients?.find((r: any) => r.username === data.userId);
      if (!airdropRecipient || airdropRecipient.claimed) {
        logger.error(`[launchpad-claim-tokens] Airdrop recipient ${data.userId} already claimed or not found.`);
        return false;
      }

      tokensToMint = toBigInt(airdropRecipient.amount);

      // Mark airdrop as claimed
      const recipientIndex = launchpad.airdropRecipients.findIndex((r: any) => r.username === data.userId);
      updateQuery[`airdropRecipients.${recipientIndex}.claimed`] = true;

    } else {
      // Handle other allocations with vesting
      const allocation = launchpad.tokenomicsSnapshot?.allocations?.find((a: any) => a.recipient === data.allocationType);
      if (!allocation) {
        logger.error(`[launchpad-claim-tokens] No allocation found for ${data.allocationType}.`);
        return false;
      }

      // Get or create vesting state
      let vestingState = await cache.findOnePromise('vesting_states', {
        userId: data.userId,
        launchpadId: data.launchpadId,
        allocationType: data.allocationType
      });

      if (!vestingState) {
        // Create initial vesting state
        const totalSupply = toBigInt(launchpad.tokenToLaunch.totalSupply);
        const totalAllocated = calculateUserAllocation(allocation, totalSupply);

        vestingState = {
          userId: data.userId,
          launchpadId: data.launchpadId,
          allocationType: data.allocationType,
          totalAllocated: toDbString(totalAllocated),
          totalClaimed: '0',
          vestingStartTimestamp: currentTimestamp,
          isFullyClaimed: false
        };

        await cache.insertOnePromise('vesting_states', vestingState);
      }

      // Calculate vested amount
      const vestingResult = calculateVestedAmount(
        allocation,
        toBigInt(vestingState.totalAllocated),
        vestingState.vestingStartTimestamp,
        currentTimestamp,
        toBigInt(vestingState.totalClaimed)
      );

      tokensToMint = vestingResult.availableToClaim;

      if (tokensToMint <= BigInt(0)) {
        logger.warn(`[launchpad-claim-tokens] No tokens available to claim for ${data.userId}. Still locked: ${vestingResult.stillLocked}`);
        return false;
      }

      // Update vesting state
      const newTotalClaimed = toBigInt(vestingState.totalClaimed) + tokensToMint;
      const isFullyClaimed = newTotalClaimed >= toBigInt(vestingState.totalAllocated);

      await cache.updateOnePromise('vesting_states', 
        { 
          userId: data.userId, 
          launchpadId: data.launchpadId, 
          allocationType: data.allocationType 
        },
        { 
          $set: { 
            totalClaimed: toDbString(newTotalClaimed),
            lastClaimedTimestamp: currentTimestamp,
            isFullyClaimed
          }
        }
      );
    }

    // Mint tokens to user account
    const success = await adjustBalance(data.userId, launchpad.mainTokenId, tokensToMint);
    if (!success) {
      logger.error(`[launchpad-claim-tokens] Failed to mint ${tokensToMint} tokens to ${data.userId}.`);
      return false;
    }

    // Update launchpad if needed
    if (Object.keys(updateQuery).length > 0) {
      updateQuery.updatedAt = new Date().toISOString();
      await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, { $set: updateQuery });
    }

    await logEvent('launchpad', 'tokens_claimed', sender, {
      launchpadId: data.launchpadId,
      allocationType: data.allocationType,
      amount: toDbString(tokensToMint),
      tokenId: launchpad.mainTokenId
    });

    logger.debug(`[launchpad-claim-tokens] Successfully claimed ${tokensToMint} tokens for ${data.userId}.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-claim-tokens] Error processing: ${error}`);
    return false;
  }
}
