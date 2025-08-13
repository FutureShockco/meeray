import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustBalance } from '../../utils/account.js';
import { LaunchpadData, LaunchpadStatus, PresaleDetails, LaunchpadParticipatePresaleData } from './launchpad-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';

// Interfaces for participant data conversion
interface LaunchpadParticipantDB {
    userId: string;
    quoteAmountContributed: string; 
    tokensAllocated?: string;
    claimed: boolean;
}

// --------------- TRANSACTION DATA INTERFACE ---------------

// --------------- TRANSACTION LOGIC ---------------

export async function validateTx(dataDb: LaunchpadParticipatePresaleData, sender: string): Promise<boolean> {
  const data = dataDb; // No conversion needed with single interface
  logger.debug(`[launchpad-participate-presale] Validating participation from ${sender} for launchpad ${data.launchpadId}: amount ${data.contributionAmount}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-participate-presale] Sender must match userId for participation.');
    return false;
  }

  if (!data.launchpadId || toBigInt(data.contributionAmount) <= BigInt(0)) {
    logger.warn('[launchpad-participate-presale] Missing or invalid fields: launchpadId, contributionAmount must be a positive value.');
    return false;
  }

  const launchpad = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
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

  if (toBigInt(data.contributionAmount) < toBigInt(presaleDetails.minContributionPerUser)) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} is below min limit ${presaleDetails.minContributionPerUser} for ${data.launchpadId}.`);
    return false;
  }
  if (toBigInt(data.contributionAmount) > toBigInt(presaleDetails.maxContributionPerUser)) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} exceeds max limit ${presaleDetails.maxContributionPerUser} for ${data.launchpadId}.`);
    return false;
  }

  const currentTotalRaised = toBigInt(launchpad.presale?.totalQuoteRaised || '0');
  if (currentTotalRaised + toBigInt(data.contributionAmount) > toBigInt(presaleDetails.hardCap)) {
    logger.warn(`[launchpad-participate-presale] Contribution ${data.contributionAmount} would exceed hard cap ${presaleDetails.hardCap} for ${data.launchpadId}. Current raised: ${currentTotalRaised}`);
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
  if (userBalance < toBigInt(data.contributionAmount)) {
    logger.warn(`[launchpad-participate-presale] Insufficient balance for ${data.userId}. Needs ${data.contributionAmount} ${contributionTokenIdentifier}, has ${userBalance}.`);
    return false;
  }

  logger.debug(`[launchpad-participate-presale] Validation successful for ${sender} on launchpad ${data.launchpadId}.`);
  return true;
}

export async function process(dataDb: LaunchpadParticipatePresaleData, sender: string, transactionId: string): Promise<boolean> {
  const data = dataDb; // No conversion needed with single interface
  logger.debug(`[launchpad-participate-presale] Processing participation from ${sender} for ${data.launchpadId}: amount ${data.contributionAmount}`);
  try {
    const launchpadFromCache = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
    const launchpad = launchpadFromCache as any; // validateTx ensures existence and presale fields
    const presaleDetails = launchpad.presaleDetailsSnapshot!;
    const contributionTokenIdentifier = `${presaleDetails.quoteAssetForPresaleSymbol}${presaleDetails.quoteAssetForPresaleIssuer ? '@' + presaleDetails.quoteAssetForPresaleIssuer : ''}`;

    const balanceAdjusted = await adjustBalance(sender, contributionTokenIdentifier, -toBigInt(data.contributionAmount));
    if (!balanceAdjusted) {
        logger.error(`[launchpad-participate-presale] Failed to deduct ${data.contributionAmount} ${contributionTokenIdentifier} from ${sender} for launchpad ${data.launchpadId}.`);
        return false;
    }

    const participantIndex = launchpad.presale!.participants.findIndex((p: any) => p.userId === data.userId);
    let updatedParticipantsList = [...launchpad.presale!.participants];
    let newTotalRaised = toBigInt(launchpad.presale!.totalQuoteRaised || '0') + toBigInt(data.contributionAmount);

    if (participantIndex > -1) {
        updatedParticipantsList[participantIndex].quoteAmountContributed = toDbString(toBigInt(updatedParticipantsList[participantIndex].quoteAmountContributed) + toBigInt(data.contributionAmount));
    } else {
        updatedParticipantsList.push({
            userId: data.userId,
            quoteAmountContributed: toDbString(toBigInt(data.contributionAmount)),
            claimed: false
        });
    }

    // Prepare fields for DB update (convert BigInts to strings for storage)
    const updatePayload = {
        $set: {
            'presale.participants': updatedParticipantsList,
            'presale.totalQuoteRaised': toDbString(newTotalRaised),
            updatedAt: new Date().toISOString(),
        }
    };

    const updateSuccessful = await cache.updateOnePromise('launchpads', { _id: data.launchpadId }, updatePayload);

    if (!updateSuccessful) {
        logger.error(`[launchpad-participate-presale] Failed to update launchpad ${data.launchpadId}.`);
        return false;
    }


    logger.debug(`[launchpad-participate-presale] Participation processed for ${data.contributionAmount}.`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-participate-presale] Error processing participation: ${error}`);
    return false;
  }
} 