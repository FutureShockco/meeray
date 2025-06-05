import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustBalance } from '../../utils/account-utils.js';
import { Launchpad, LaunchpadStatus, PresaleDetails, LaunchpadParticipatePresaleData, LaunchpadParticipatePresaleDataDB } from './launchpad-interfaces.js';
import { toBigInt, toString, convertToBigInt, BigIntMath } from '../../utils/bigint-utils.js';
import { logTransactionEvent } from '../../utils/event-logger.js';

const NUMERIC_FIELDS_PARTICIPATE: Array<keyof LaunchpadParticipatePresaleData> = ['contributionAmount'];

// Type for participant data as stored in DB (with stringified BigInts)
interface LaunchpadParticipantDB {
    userId: string;
    quoteAmountContributed: string; 
    tokensAllocated?: string;
    claimed: boolean;
}

// Type for participant data in application logic (with BigInts)
interface LaunchpadParticipant {
    userId: string;
    quoteAmountContributed: bigint; 
    tokensAllocated?: bigint;
    claimed: boolean;
}

// --------------- TRANSACTION DATA INTERFACE ---------------

// --------------- TRANSACTION LOGIC ---------------

export async function validateTx(dataDb: LaunchpadParticipatePresaleDataDB, sender: string): Promise<boolean> {
  const data = convertToBigInt<LaunchpadParticipatePresaleData>(dataDb, NUMERIC_FIELDS_PARTICIPATE);
  logger.debug(`[launchpad-participate-presale] Validating participation from ${sender} for launchpad ${data.launchpadId}: amount ${toString(data.contributionAmount)}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-participate-presale] Sender must match userId for participation.');
    return false;
  }

  if (!data.launchpadId || data.contributionAmount <= BigInt(0)) {
    logger.warn('[launchpad-participate-presale] Missing or invalid fields: launchpadId, contributionAmount must be a positive BigInt.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId }) as Launchpad | null;
  if (!launchpad) {
    logger.warn(`[launchpad-participate-presale] Launchpad project ${data.launchpadId} not found.`);
    return false;
  }

  if (launchpad.status !== LaunchpadStatus.PRESALE_ACTIVE) {
    logger.warn(`[launchpad-participate-presale] Launchpad ${data.launchpadId} presale is not active. Current status: ${launchpad.status}`);
    return false;
  }

  if (!launchpad.presaleDetailsSnapshot) {
    logger.warn(`[launchpad-participate-presale] Launchpad ${data.launchpadId} does not have presale details configured.`);
    return false;
  }
  // presaleDetailsSnapshot amounts are BigInt due to interface changes
  const presaleDetails = launchpad.presaleDetailsSnapshot;

  if (data.contributionAmount < presaleDetails.minContributionPerUser) {
    logger.warn(`[launchpad-participate-presale] Contribution ${toString(data.contributionAmount)} is below min limit ${toString(presaleDetails.minContributionPerUser)} for ${data.launchpadId}.`);
    return false;
  }
  if (data.contributionAmount > presaleDetails.maxContributionPerUser) {
    logger.warn(`[launchpad-participate-presale] Contribution ${toString(data.contributionAmount)} exceeds max limit ${toString(presaleDetails.maxContributionPerUser)} for ${data.launchpadId}.`);
    return false;
  }

  const currentTotalRaised = launchpad.presale?.totalQuoteRaised || BigInt(0);
  if (BigIntMath.add(currentTotalRaised, data.contributionAmount) > presaleDetails.hardCap) {
    logger.warn(`[launchpad-participate-presale] Contribution ${toString(data.contributionAmount)} would exceed hard cap ${toString(presaleDetails.hardCap)} for ${data.launchpadId}. Current raised: ${toString(currentTotalRaised)}`);
    return false;
  }

  // Whitelist check (if applicable) - remains placeholder

  const userAccount = await getAccount(data.userId);
  if (!userAccount) {
    logger.warn(`[launchpad-participate-presale] User account ${data.userId} not found.`);
    return false;
  }
  const contributionTokenIdentifier = `${presaleDetails.quoteAssetForPresaleSymbol}${presaleDetails.quoteAssetForPresaleIssuer ? '@' + presaleDetails.quoteAssetForPresaleIssuer : ''}`;
  const userBalanceString = userAccount.balances?.[contributionTokenIdentifier] || '0';
  const userBalance = toBigInt(userBalanceString);
  if (userBalance < data.contributionAmount) {
    logger.warn(`[launchpad-participate-presale] Insufficient balance for ${data.userId}. Needs ${toString(data.contributionAmount)} ${contributionTokenIdentifier}, has ${toString(userBalance)}.`);
    return false;
  }

  logger.debug(`[launchpad-participate-presale] Validation successful for ${sender} on launchpad ${data.launchpadId}.`);
  return true;
}

export async function process(dataDb: LaunchpadParticipatePresaleDataDB, sender: string, transactionId: string): Promise<boolean> {
  const data = convertToBigInt<LaunchpadParticipatePresaleData>(dataDb, NUMERIC_FIELDS_PARTICIPATE);
  logger.debug(`[launchpad-participate-presale] Processing participation from ${sender} for ${data.launchpadId}: amount ${toString(data.contributionAmount)}`);
  try {
    const launchpadFromCache = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    if (!launchpadFromCache || !launchpadFromCache.presaleDetailsSnapshot || !launchpadFromCache.presale) {
        logger.error(`[launchpad-participate-presale] CRITICAL: Launchpad ${data.launchpadId} or its presale details not found during processing.`);
        return false;
    }
    // Convert launchpadFromCache (DB format with strings) to Launchpad (internal format with BigInts)
    // Define keys that need conversion to BigInt in the fetched launchpad data
    const launchpadNumericFields: (keyof Launchpad)[] = []; // Add actual keys if Launchpad itself has direct BigInt fields
    const presaleNumericFields: (keyof PresaleDetails)[] = ['pricePerToken', 'minContributionPerUser', 'maxContributionPerUser', 'hardCap', 'softCap'];
    
    // This is a simplified conversion, assuming presale and presaleDetailsSnapshot are the primary concerns for BigInts.
    // A full deep conversion utility would be more robust.
    const launchpad: Launchpad = {
        ...launchpadFromCache,
        tokenToLaunch: launchpadFromCache.tokenToLaunch ? { ...launchpadFromCache.tokenToLaunch, totalSupply: toBigInt(launchpadFromCache.tokenToLaunch.totalSupply) } : undefined as any,
        tokenomicsSnapshot: launchpadFromCache.tokenomicsSnapshot ? { ...launchpadFromCache.tokenomicsSnapshot, totalSupply: toBigInt(launchpadFromCache.tokenomicsSnapshot.totalSupply), tokenDecimals: toBigInt(launchpadFromCache.tokenomicsSnapshot.tokenDecimals) } : undefined as any,
        presaleDetailsSnapshot: launchpadFromCache.presaleDetailsSnapshot ? convertToBigInt<PresaleDetails>(launchpadFromCache.presaleDetailsSnapshot as any, presaleNumericFields) : undefined,
        presale: launchpadFromCache.presale ? {
            ...launchpadFromCache.presale,
            totalQuoteRaised: toBigInt(launchpadFromCache.presale.totalQuoteRaised),
            participants: launchpadFromCache.presale.participants.map((p: LaunchpadParticipantDB): LaunchpadParticipant => ({
                ...p,
                quoteAmountContributed: toBigInt(p.quoteAmountContributed),
                tokensAllocated: p.tokensAllocated ? toBigInt(p.tokensAllocated) : undefined
            }))
        } : undefined as any,
        feeDetails: launchpadFromCache.feeDetails ? { ...launchpadFromCache.feeDetails, amount: toBigInt(launchpadFromCache.feeDetails.amount) } : undefined,
    } as Launchpad;

    const presaleDetails = launchpad.presaleDetailsSnapshot!;
    const contributionTokenIdentifier = `${presaleDetails.quoteAssetForPresaleSymbol}${presaleDetails.quoteAssetForPresaleIssuer ? '@' + presaleDetails.quoteAssetForPresaleIssuer : ''}`;

    const balanceAdjusted = await adjustBalance(sender, contributionTokenIdentifier, -data.contributionAmount); // data.contributionAmount is BigInt
    if (!balanceAdjusted) {
        logger.error(`[launchpad-participate-presale] Failed to deduct ${toString(data.contributionAmount)} ${contributionTokenIdentifier} from ${sender} for launchpad ${data.launchpadId}.`);
        return false;
    }

    const participantIndex = launchpad.presale!.participants.findIndex(p => p.userId === data.userId);
    let updatedParticipantsList = [...launchpad.presale!.participants];
    let newTotalRaised = BigIntMath.add(launchpad.presale!.totalQuoteRaised || BigInt(0), data.contributionAmount);

    if (participantIndex > -1) {
        updatedParticipantsList[participantIndex].quoteAmountContributed = BigIntMath.add(updatedParticipantsList[participantIndex].quoteAmountContributed, data.contributionAmount);
    } else {
        updatedParticipantsList.push({
            userId: data.userId,
            quoteAmountContributed: data.contributionAmount,
            claimed: false
        });
    }

    // Prepare fields for DB update (convert BigInts back to strings)
    const updatePayload = {
        $set: {
            'presale.participants': updatedParticipantsList.map((p: LaunchpadParticipant): LaunchpadParticipantDB => ({
                ...p,
                quoteAmountContributed: toString(p.quoteAmountContributed),
                tokensAllocated: p.tokensAllocated ? toString(p.tokensAllocated) : undefined
            })),
            'presale.totalQuoteRaised': toString(newTotalRaised),
            updatedAt: new Date().toISOString(),
        }
    };

    const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);

    if (!updateSuccessful) {
        logger.error(`[launchpad-participate-presale] Failed to update launchpad ${data.launchpadId}. Rolling back balance.`);
        await adjustBalance(sender, contributionTokenIdentifier, data.contributionAmount); // Rollback with positive BigInt
        return false;
    }

    // Log event using the new centralized logger
    const eventData = {
        launchpadId: data.launchpadId,
        userId: data.userId,
        contributionAmount: toString(data.contributionAmount),
        contributionTokenSymbol: presaleDetails.quoteAssetForPresaleSymbol,
        contributionTokenIssuer: presaleDetails.quoteAssetForPresaleIssuer,
        newTotalRaised: toString(newTotalRaised)
    };
    await logTransactionEvent('launchpadPresaleParticipation', sender, eventData, transactionId);

    logger.debug(`[launchpad-participate-presale] Participation processed for ${toString(data.contributionAmount)}.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-participate-presale] Error processing participation: ${error}`);
    return false;
  }
} 