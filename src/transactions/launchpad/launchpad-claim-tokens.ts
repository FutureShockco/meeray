import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { Launchpad, LaunchpadStatus, Token, TokenAllocation, TokenDistributionRecipient, LaunchpadClaimTokensData } from './launchpad-interfaces.js';
import { toString, toBigInt } from '../../utils/bigint-utils.js';

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

  // Convert launchpadFromCache to Launchpad with BigInts for internal logic
  // This is a simplified deep conversion. A utility function would be better.
  const launchpad: Launchpad = {
      ...launchpadFromCache,
      tokenToLaunch: launchpadFromCache.tokenToLaunch ? { ...launchpadFromCache.tokenToLaunch, totalSupply: toBigInt(launchpadFromCache.tokenToLaunch.totalSupply) } : undefined as any,
      tokenomicsSnapshot: launchpadFromCache.tokenomicsSnapshot ? { 
          ...launchpadFromCache.tokenomicsSnapshot, 
          totalSupply: toBigInt(launchpadFromCache.tokenomicsSnapshot.totalSupply), 
          tokenDecimals: toBigInt(launchpadFromCache.tokenomicsSnapshot.tokenDecimals) 
      } : undefined as any,
      presaleDetailsSnapshot: launchpadFromCache.presaleDetailsSnapshot ? { 
          ...launchpadFromCache.presaleDetailsSnapshot,
          pricePerToken: toBigInt(launchpadFromCache.presaleDetailsSnapshot.pricePerToken),
          minContributionPerUser: toBigInt(launchpadFromCache.presaleDetailsSnapshot.minContributionPerUser),
          maxContributionPerUser: toBigInt(launchpadFromCache.presaleDetailsSnapshot.maxContributionPerUser),
          hardCap: toBigInt(launchpadFromCache.presaleDetailsSnapshot.hardCap),
          softCap: launchpadFromCache.presaleDetailsSnapshot.softCap ? toBigInt(launchpadFromCache.presaleDetailsSnapshot.softCap) : undefined,
      } : undefined,
      presale: launchpadFromCache.presale ? {
          ...launchpadFromCache.presale,
          totalQuoteRaised: toBigInt(launchpadFromCache.presale.totalQuoteRaised),
          participants: launchpadFromCache.presale.participants.map((p: any) => ({ // p is from DB (string amounts)
              ...p,
              quoteAmountContributed: toBigInt(p.quoteAmountContributed),
              tokensAllocated: p.tokensAllocated ? toBigInt(p.tokensAllocated) : undefined
          }))
      } : undefined as any,
      feeDetails: launchpadFromCache.feeDetails ? { ...launchpadFromCache.feeDetails, amount: toBigInt(launchpadFromCache.feeDetails.amount) } : undefined,
  } as Launchpad;

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
    const participant = launchpad.presale.participants.find(p => p.userId === data.userId);
    if (!participant) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} not found in presale participants for ${data.launchpadId}.`);
      return false;
    }
    if (participant.claimed) {
      logger.warn(`[launchpad-claim-tokens] User ${data.userId} has already claimed presale tokens for ${data.launchpadId}.`);
      return false;
    }
    // participant.tokensAllocated is already BigInt here due to conversion above
    if (!participant.tokensAllocated || participant.tokensAllocated <= BigInt(0)) {
        logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no tokens allocated or allocation is zero for ${data.launchpadId}.`);
        return false;
    }
  } else {
    logger.warn(`[launchpad-claim-tokens] Claiming for allocation type ${data.allocationType} is not fully implemented yet.`);
  }
  
  const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId }) as Token | null;
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
    
    // Convert launchpadFromCache to Launchpad with BigInts for internal logic
    // This is a simplified deep conversion. A utility function would be better.
    const launchpad: Launchpad = {
        ...launchpadFromCache,
        tokenToLaunch: launchpadFromCache.tokenToLaunch ? { ...launchpadFromCache.tokenToLaunch, totalSupply: toBigInt(launchpadFromCache.tokenToLaunch.totalSupply) } : undefined as any,
        tokenomicsSnapshot: launchpadFromCache.tokenomicsSnapshot ? { 
            ...launchpadFromCache.tokenomicsSnapshot, 
            totalSupply: toBigInt(launchpadFromCache.tokenomicsSnapshot.totalSupply), 
            tokenDecimals: toBigInt(launchpadFromCache.tokenomicsSnapshot.tokenDecimals) 
        } : undefined as any,
        presaleDetailsSnapshot: launchpadFromCache.presaleDetailsSnapshot ? { 
            ...launchpadFromCache.presaleDetailsSnapshot,
            pricePerToken: toBigInt(launchpadFromCache.presaleDetailsSnapshot.pricePerToken),
            minContributionPerUser: toBigInt(launchpadFromCache.presaleDetailsSnapshot.minContributionPerUser),
            maxContributionPerUser: toBigInt(launchpadFromCache.presaleDetailsSnapshot.maxContributionPerUser),
            hardCap: toBigInt(launchpadFromCache.presaleDetailsSnapshot.hardCap),
            softCap: launchpadFromCache.presaleDetailsSnapshot.softCap ? toBigInt(launchpadFromCache.presaleDetailsSnapshot.softCap) : undefined,
        } : undefined,
        presale: launchpadFromCache.presale ? {
            ...launchpadFromCache.presale,
            totalQuoteRaised: toBigInt(launchpadFromCache.presale.totalQuoteRaised),
            participants: launchpadFromCache.presale.participants.map((p: any) => ({ // p is from DB (string amounts)
                ...p,
                quoteAmountContributed: toBigInt(p.quoteAmountContributed),
                tokensAllocated: p.tokensAllocated ? toBigInt(p.tokensAllocated) : undefined
            }))
        } : undefined as any,
        feeDetails: launchpadFromCache.feeDetails ? { ...launchpadFromCache.feeDetails, amount: toBigInt(launchpadFromCache.feeDetails.amount) } : undefined,
    } as Launchpad;

    const tokenInfo = await cache.findOnePromise('tokens', { _id: launchpad.mainTokenId }) as Token | null;
    if (!tokenInfo) {
        logger.error(`[launchpad-claim-tokens] CRITICAL: Token info for ${launchpad.mainTokenId} not found during processing.`);
        return false;
    }

    let tokensToClaim: bigint = BigInt(0); // Initialize as BigInt
    let participantListUpdateRequired = false;
    let participantDbList: any[] = []; // To store participants in DB format for update

    if (data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        if (!launchpad.presale || !launchpad.presale.participants) {
            logger.error(`[launchpad-claim-tokens] CRITICAL: Presale data missing for ${data.launchpadId} during claim.`);
            return false;
        }
        const participantIndex = launchpad.presale.participants.findIndex(p => p.userId === data.userId);
        const participant = participantIndex > -1 ? launchpad.presale.participants[participantIndex] : null;

        if (!participant || !participant.tokensAllocated || participant.tokensAllocated <= BigInt(0)) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} has no allocated presale tokens or not found for ${data.launchpadId}.`);
            return false; 
        }
        if (participant.claimed) {
            logger.warn(`[launchpad-claim-tokens] User ${data.userId} already claimed presale tokens for ${data.launchpadId} (caught in process).`);
            return false;
        }

        tokensToClaim = participant.tokensAllocated; // This is already BigInt
        
        // Update the specific participant in the list for DB update
        participantDbList = launchpad.presale.participants.map((p, index) => {
            const pDb = {
                ...p,
                quoteAmountContributed: toString(p.quoteAmountContributed),
                tokensAllocated: p.tokensAllocated ? toString(p.tokensAllocated) : undefined,
                claimed: index === participantIndex ? true : p.claimed // Set claimed to true for the current claimer
            };
            return pDb;
        });
        participantListUpdateRequired = true;

    } else {
        logger.warn(`[launchpad-claim-tokens] Claim processing for ${data.allocationType} needs specific implementation.`);
        return false; 
    }

    if (tokensToClaim <= BigInt(0)) { // Compare with BigInt(0)
        logger.warn(`[launchpad-claim-tokens] No tokens to claim for ${data.userId} on ${data.launchpadId} for type ${data.allocationType}.`);
        return false;
    }

    const issueSuccess = await adjustBalance(data.userId, launchpad.mainTokenId!, tokensToClaim); // tokensToClaim is BigInt
    
    if (!issueSuccess) {
        logger.error(`[launchpad-claim-tokens] Failed to issue ${toString(tokensToClaim)} of ${launchpad.mainTokenId} to ${data.userId}.`);
        return false; // No rollback of claimed flag here as token transfer is the primary action
    }

    if (participantListUpdateRequired && data.allocationType === TokenDistributionRecipient.PRESALE_PARTICIPANTS) {
        const updatePayload = {
            $set: {
                'presale.participants': participantDbList, // Use the stringified list
                updatedAt: new Date().toISOString(),
            }
        };
        const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);
        if (!updateSuccessful) {
            logger.error(`[launchpad-claim-tokens] Failed to update launchpad ${data.launchpadId} after claim. Token issued - requires reconciliation.`);
        }
    }

    const eventDocument = {
      type: 'launchpadTokensClaimed',
      timestamp: new Date().toISOString(),
      actor: sender,
      data: {
        launchpadId: data.launchpadId,
        userId: data.userId,
        tokenId: launchpad.mainTokenId,
        amountClaimed: toString(tokensToClaim), // Log as string
        allocationType: data.allocationType
      }
    };
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[launchpad-claim-tokens] CRITICAL: Failed to log token claim event: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    logger.debug(`[launchpad-claim-tokens] Claim by ${sender} for ${toString(tokensToClaim)} of ${launchpad.mainTokenId} from ${data.launchpadId} processed.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-claim-tokens] Error processing claim by ${sender} for ${data.launchpadId}: ${error}`);
    return false;
  }
}

