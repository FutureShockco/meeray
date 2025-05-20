import logger from '../../logger.js';
import cache from '../../cache.js';
// import { getAccount, adjustBalance, issueTokenToAccount } from '../../utils/account-utils.js'; // TODO: Define and use issueTokenToAccount
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { Launchpad, LaunchpadStatus, Token, TokenAllocation, TokenDistributionRecipient } from './launchpad-launch-token.js';

// --------------- TRANSACTION DATA INTERFACE ---------------

export interface LaunchpadClaimTokensData {
  userId: string; // User claiming tokens
  launchpadId: string; // ID of the launchpad project
  // Claiming for a specific allocation type, e.g., PRESALE_PARTICIPANTS
  // For presale, amount is determined by their contribution and final token price.
  // For other allocations (like team, advisors), this might be more direct.
  allocationType: TokenDistributionRecipient; // e.g., PRESALE_PARTICIPANTS, AIRDROP_REWARDS etc.
}

// --------------- TRANSACTION LOGIC ---------------

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

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId }) as Launchpad | null;
  if (!launchpad) {
    logger.warn(`[launchpad-claim-tokens] Launchpad project ${data.launchpadId} not found.`);
    return false;
  }

  // Check if launchpad is in a state where claims are allowed
  const claimableStatuses = [
    LaunchpadStatus.PRESALE_SUCCEEDED_HARDCAP_MET, 
    LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET, 
    LaunchpadStatus.TOKEN_GENERATION_EVENT, // Depending on when TGE happens
    LaunchpadStatus.COMPLETED, // If claims are still allowed post-completion for some allocations
    LaunchpadStatus.TRADING_LIVE // Often TGE and Trading Live are when claims open
  ];
  if (!claimableStatuses.includes(launchpad.status)) {
    logger.warn(`[launchpad-claim-tokens] Launchpad ${data.launchpadId} is not in a claimable status. Current status: ${launchpad.status}`);
    return false;
  }
  if (!launchpad.mainTokenId) {
      logger.warn(`[launchpad-claim-tokens] Main token ID not yet set for launchpad ${data.launchpadId}. Tokens might not be generated.`);
      return false;
  }

  // Specific validation based on allocationType
  if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
    if (!launchpad.presale || !launchpad.presale.participants) {
      logger.warn(`[launchpad-claim-tokens] No presale participant data found for ${data.launchpadId}.`);
      return false;
    }
    const participant = launchpad.presale.participants.find(p => p.userId === data.userId);
    if (!participant) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} not found in presale participants for ${data.launchpadId}.`);
      return false;
    }
    if (participant.claimed) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} has already claimed their presale tokens for ${data.launchpadId}.`);
      return false;
    }
    if (!participant.tokensAllocated || participant.tokensAllocated <= 0) {
        logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no tokens allocated or allocation is zero for ${data.launchpadId}.`);
        return false;
    }
    // TODO: Add vesting schedule checks here. Can they claim now? How much?

  } else {
    // For other allocation types (team, advisors, airdrop, etc.)
    // Logic would be different. It might involve checking the Tokenomics snapshot
    // and a separate record of claimed amounts for these allocations.
    // This part would need significant expansion based on how these are managed.
    logger.warn(`[launchpad-claim-tokens] Claiming for allocation type ${data.allocationType} is not fully implemented yet.`);
    // return false; // For now, allow to proceed to process for further logging if needed
  }
  
  const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId }) as Token | null;
  if (!tokenInfo) {
      logger.warn(`[launchpad-claim-tokens] Token information for ${launchpad.mainTokenId} not found.`);
      return false;
  }

  logger.info(`[launchpad-claim-tokens] Validation successful for ${sender} on launchpad ${data.launchpadId}.`);
  return true;
}

export async function process(data: LaunchpadClaimTokensData, sender: string): Promise<boolean> {
  logger.info(`[launchpad-claim-tokens] Processing claim from ${sender} for ${data.launchpadId}, type ${data.allocationType}: ${JSON.stringify(data)}`);
  try {
    const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId }) as Launchpad | null;
    if (!launchpad || !launchpad.mainTokenId) { 
        logger.error(`[launchpad-claim-tokens] CRITICAL: Launchpad ${data.launchpadId} or mainTokenId not found during processing.`);
        return false;
    }
    
    const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId }) as Token | null;
    if (!tokenInfo) {
        logger.error(`[launchpad-claim-tokens] CRITICAL: Token info for ${launchpad.mainTokenId} not found during processing.`);
        return false;
    }

    let tokensToClaim = 0;
    let participantListUpdateRequired = false;

    if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        if (!launchpad.presale || !launchpad.presale.participants) {
            logger.error(`[launchpad-claim-tokens] CRITICAL: Presale data missing for ${data.launchpadId} during claim.`);
            return false;
        }
        const participantIndex = launchpad.presale.participants.findIndex(p => p.userId === data.userId);
        if (participantIndex === -1 || !launchpad.presale.participants[participantIndex].tokensAllocated || launchpad.presale.participants[participantIndex].tokensAllocated <=0 ) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no allocated presale tokens or not found for ${data.launchpadId}.`);
            return false; 
        }
        if (launchpad.presale.participants[participantIndex].claimed) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} already claimed presale tokens for ${data.launchpadId} (caught in process).`);
            return false;
        }

        tokensToClaim = launchpad.presale.participants[participantIndex].tokensAllocated!;
        
        launchpad.presale.participants[participantIndex].claimed = true;
        participantListUpdateRequired = true;

    } else {
        logger.warn(`[launchpad-claim-tokens] Claim processing for ${data.allocationType} needs specific implementation.`);
        return false; 
    }

    if (tokensToClaim <= 0) {
        logger.warn(`[launchpad-claim-tokens] No tokens to claim for ${data.userId} on ${data.launchpadId} for type ${data.allocationType}.`);
        return false;
    }

    // 1. Issue/transfer tokens to user by adjusting their balance
    const issueSuccess = await adjustBalance(data.userId, launchpad.mainTokenId, tokensToClaim);
    
    if (!issueSuccess) {
        logger.error(`[launchpad-claim-tokens] Failed to issue ${tokensToClaim} of ${launchpad.mainTokenId} to ${data.userId} by adjusting balance.`);
        // Revert 'claimed' status if token issuance failed
        if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS && participantListUpdateRequired) {
            const pIdx = launchpad.presale!.participants.findIndex(p => p.userId === data.userId);
            if (pIdx > -1) launchpad.presale!.participants[pIdx].claimed = false; 
        }
        return false;
    }

    // 2. Update Launchpad document if participant list was modified
    if (participantListUpdateRequired && data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        const updatePayload = {
            $set: {
                'presale.participants': launchpad.presale!.participants,
                updatedAt: new Date().toISOString(),
            }
        };
        const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);
        if (!updateSuccessful) {
            logger.error(`[launchpad-claim-tokens] Failed to update launchpad ${data.launchpadId} after claim by ${sender}. Token already issued - requires reconciliation.`);
            // This is a problematic state. Token issued but DB state not updated.
            // A more robust system might use a 2-phase commit or saga pattern.
        }
    }

    // 3. Log event
    const eventDocument = {
      type: 'launchpadTokensClaimed',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        launchpadId: data.launchpadId,
        userId: data.userId,
        tokenId: launchpad.mainTokenId,
        amountClaimed: tokensToClaim,
        allocationType: data.allocationType
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[launchpad-claim-tokens] CRITICAL: Failed to log token claim event for ${data.launchpadId} by ${sender}: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    logger.info(`[launchpad-claim-tokens] Claim by ${sender} for ${tokensToClaim} of ${launchpad.mainTokenId} from launchpad ${data.launchpadId} processed successfully.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-claim-tokens] Error processing claim by ${sender} for ${data.launchpadId}: ${error}`);
    return false;
  }
}

// Placeholder for a utility function that would be in account-utils.js
// We'll need to define this properly later.
// declare module '../../utils/account-utils.js' {
//   export function issueTokenToAccount(userId: string, tokenId: string, amount: number, tokenSymbol: string, tokenIssuer?: string): Promise<boolean>;
// } 