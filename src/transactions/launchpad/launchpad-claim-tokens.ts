import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { LaunchpadStatus, TokenDistributionRecipient, LaunchpadClaimTokensData } from './launchpad-interfaces.js';
import { toBigInt } from '../../utils/bigint.js';

export async function validateTx(data: LaunchpadClaimTokensData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-claim-tokens] Validating claim from ${sender} for launchpad ${data.launchpadId}, type ${data.allocationType}: ${JSON.stringify(data)}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-claim-tokens] Sender must match userId for claiming tokens.');
    return false;
  }

  if (!data.launchpadId || !data.allocationType) {
    logger.warn('[launchpad-claim-tokens] Missing required fields: launchpadId, allocationType.');
    return false;
  }

  const launchpadFromCache = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
  if (!launchpadFromCache) {
    logger.warn(`[launchpad-claim-tokens] Launchpad project ${data.launchpadId} not found.`);
    return false;
  }

  // Use data directly without complex conversions
  const launchpad = launchpadFromCache;

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
    if (participant.claimed) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} has already claimed presale tokens for ${data.launchpadId}.`);
      return false;
    }
    // Convert tokensAllocated to BigInt for comparison
    const tokensAllocated = toBigInt(participant.tokensAllocated || '0');
    if (tokensAllocated <= BigInt(0)) {
        logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no tokens allocated or allocation is zero for ${data.launchpadId}.`);
        return false;
    }
  } else {
    logger.warn(`[launchpad-claim-tokens] Claiming for allocation type ${data.allocationType} is not fully implemented yet.`);
  }
  
  const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId });
  if (!tokenInfo) {
      logger.warn(`[launchpad-claim-tokens] Token information for ${launchpad.mainTokenId} not found.`);
      return false;
  }
  logger.debug(`[launchpad-claim-tokens] Validation successful for ${sender} on launchpad ${data.launchpadId}.`);
  return true;
}

export async function process(data: LaunchpadClaimTokensData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-claim-tokens] Processing claim from ${sender} for ${data.launchpadId}, type ${data.allocationType}: ${JSON.stringify(data)}`);
  try {
    const launchpadFromCache = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpadFromCache || !launchpadFromCache.mainTokenId) { 
        logger.error(`[launchpad-claim-tokens] CRITICAL: Launchpad ${data.launchpadId} or mainTokenId not found during processing.`);
        return false;
    }
    
    // Use data directly without complex conversions
    const launchpad = launchpadFromCache;

    const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId });
    if (!tokenInfo) {
        logger.error(`[launchpad-claim-tokens] CRITICAL: Token info for ${launchpad.mainTokenId} not found during processing.`);
        return false;
    }

    let tokensToClaim: bigint = BigInt(0);
    let participantListUpdateRequired = false;
    let participantDbList: any[] = [];

    if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        if (!launchpad.presale || !launchpad.presale.participants) {
            logger.error(`[launchpad-claim-tokens] CRITICAL: Presale data missing for ${data.launchpadId} during claim.`);
            return false;
        }
        const participantIndex = launchpad.presale.participants.findIndex((p: any) => p.userId === data.userId);
        const participant = participantIndex > -1 ? launchpad.presale.participants[participantIndex] : null;

        if (!participant) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} not found for ${data.launchpadId}.`);
            return false; 
        }
        
        const tokensAllocated = toBigInt(participant.tokensAllocated || '0');
        if (tokensAllocated <= BigInt(0)) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no allocated presale tokens for ${data.launchpadId}.`);
            return false; 
        }
        if (participant.claimed) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} already claimed presale tokens for ${data.launchpadId} (caught in process).`);
            return false;
        }

        tokensToClaim = tokensAllocated;
        
        // Update the specific participant in the list for DB update
        participantDbList = launchpad.presale.participants.map((p: any, index: number) => {
            return {
                ...p,
                claimed: index === participantIndex ? true : p.claimed // Set claimed to true for the current claimer
            };
        });
        participantListUpdateRequired = true;

    } else {
        logger.warn(`[launchpad-claim-tokens] Claim processing for ${data.allocationType} needs specific implementation.`);
        return false; 
    }

    if (tokensToClaim <= BigInt(0)) {
        logger.warn(`[launchpad-claim-tokens] No tokens to claim for ${data.userId} on ${data.launchpadId} for type ${data.allocationType}.`);
        return false;
    }

    const issueSuccess = await adjustBalance(data.userId, launchpad.mainTokenId!, tokensToClaim);
    
    if (!issueSuccess) {
        logger.error(`[launchpad-claim-tokens] Failed to issue ${tokensToClaim} of ${launchpad.mainTokenId} to ${data.userId}.`);
        return false;
    }

    if (participantListUpdateRequired && data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        const updatePayload = {
            $set: {
                'presale.participants': participantDbList,
                updatedAt: new Date().toISOString(),
            }
        };
        const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);
        if (!updateSuccessful) {
            logger.error(`[launchpad-claim-tokens] Failed to update launchpad ${data.launchpadId} after claim. Token issued - requires reconciliation.`);
        }
    }


    logger.debug(`[launchpad-claim-tokens] Claim by ${sender} for ${tokensToClaim} of ${launchpad.mainTokenId} from ${data.launchpadId} processed.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-claim-tokens] Error processing claim by ${sender} for ${data.launchpadId}: ${error}`);
    return false;
  }
}

