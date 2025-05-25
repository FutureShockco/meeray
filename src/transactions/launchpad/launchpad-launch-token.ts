import logger from '../../logger.js';
import cache from '../../cache.js';
// import validate from '../../validation/index.js'; // Assuming a validation library might be used
import { getAccount, adjustBalance } from '../../utils/account-utils.js'; // Assuming account utilities
import crypto from 'crypto';
import {
  TokenStandard,
  VestingType,
  VestingSchedule,
  TokenDistributionRecipient,
  TokenAllocation,
  Tokenomics,
  PresaleDetails,
  LiquidityProvisionDetails,
  LaunchpadLaunchTokenData,
  LaunchpadStatus,
  Token,
  Launchpad,
  LaunchpadDB
} from './launchpad-interfaces.js';
import { BigIntMath, toString } from '../../utils/bigint-utils.js'; // Removed convertToString as we'll do it manually for deep objects
import validate from '../../validation/index.js'; // Assuming validate exists
import config from '../../config.js'; // Import config


function generateLaunchpadId(): string {
  return `lp-${crypto.randomBytes(12).toString('hex')}`; // Example: lp- + 24 char hex
}

function generateTokenId(symbol: string, issuer?: string): string {
  if (issuer) {
    return `${symbol.toUpperCase()}@${issuer}`;
  }
  // For native tokens or system-generated unique IDs
  return `${symbol.toUpperCase()}-${crypto.randomBytes(8).toString('hex')}`;
}


// --------------- TRANSACTION LOGIC ---------------

export async function validateTx(data: LaunchpadLaunchTokenData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Validating launch request from ${sender}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-launch-token] Sender must match userId for the launch request.');
    return false;
  }

  if (!data.tokenName || !data.tokenSymbol || !data.tokenStandard || !data.tokenomics) {
    logger.warn('[launchpad-launch-token] Missing core token information.');
    return false;
  }

  if (!validate.string(data.tokenSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
      logger.warn('[launchpad-launch-token] Invalid token symbol format.');
      return false;
  }

  // Validate tokenomics decimals and totalSupply
  if (data.tokenomics.tokenDecimals < BigInt(0) || data.tokenomics.tokenDecimals > BigInt(18)) {
    logger.warn('[launchpad-launch-token] Token decimals must be between 0 and 18.');
    return false;
  }
  if (data.tokenomics.totalSupply <= BigInt(0)) {
    logger.warn('[launchpad-launch-token] Total supply must be positive.');
    return false;
  }

  // TODO: Add other comprehensive validations as listed in comments in original file

  logger.debug('[launchpad-launch-token] Validation passed (structure and basic tokenomics check).');
  return true;
}

export async function process(data: LaunchpadLaunchTokenData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Processing launch request from ${sender}`);
  try {
    // Assuming validateTx was called by the node before processing

    const launchpadId = generateLaunchpadId();
    const now = new Date().toISOString();
    
    const tokenDecimalsNumber = BigIntMath.toNumber(data.tokenomics.tokenDecimals);
    // Additional check, even if validated in validateTx, for safety during conversion
    if (tokenDecimalsNumber < 0 || tokenDecimalsNumber > 18) {
        logger.error('[launchpad-launch-token] CRITICAL: Invalid token decimals during processing.');
        return false; 
    }

    const launchpadProjectData: Launchpad = {
      _id: launchpadId,
      projectId: `${data.tokenSymbol}-launch-${launchpadId.substring(0,8)}`,
      status: LaunchpadStatus.UPCOMING, // Assuming validation passed if we reach here
      tokenToLaunch: {
        name: data.tokenName,
        symbol: data.tokenSymbol,
        standard: data.tokenStandard,
        decimals: tokenDecimalsNumber, // Use converted number
        totalSupply: data.tokenomics.totalSupply, // Use bigint directly
      },
      tokenomicsSnapshot: data.tokenomics, // This has BigInt fields
      presaleDetailsSnapshot: data.presaleDetails, // This has BigInt fields as per interface changes
      liquidityProvisionDetailsSnapshot: data.liquidityProvisionDetails,
      launchedByUserId: sender,
      createdAt: now,
      updatedAt: now,
      feePaid: false, 
      presale: data.presaleDetails ? {
          totalQuoteRaised: BigInt(0), // Initialize with BigInt(0)
          participants: [],
          status: 'NOT_STARTED'
      } : undefined,
    };
    
    // Manually construct the object for DB with deep string conversion for BigInts
    const dbDoc = {
      ...launchpadProjectData,
      tokenToLaunch: {
        ...launchpadProjectData.tokenToLaunch,
        totalSupply: toString(launchpadProjectData.tokenToLaunch.totalSupply),
      },
      tokenomicsSnapshot: {
        ...launchpadProjectData.tokenomicsSnapshot,
        totalSupply: toString(launchpadProjectData.tokenomicsSnapshot.totalSupply),
        tokenDecimals: toString(launchpadProjectData.tokenomicsSnapshot.tokenDecimals),
      },
      presaleDetailsSnapshot: launchpadProjectData.presaleDetailsSnapshot ? {
        ...launchpadProjectData.presaleDetailsSnapshot,
        pricePerToken: toString(launchpadProjectData.presaleDetailsSnapshot.pricePerToken),
        minContributionPerUser: toString(launchpadProjectData.presaleDetailsSnapshot.minContributionPerUser),
        maxContributionPerUser: toString(launchpadProjectData.presaleDetailsSnapshot.maxContributionPerUser),
        hardCap: toString(launchpadProjectData.presaleDetailsSnapshot.hardCap),
        softCap: launchpadProjectData.presaleDetailsSnapshot.softCap ? toString(launchpadProjectData.presaleDetailsSnapshot.softCap) : undefined,
      } : undefined,
      presale: launchpadProjectData.presale ? {
        ...launchpadProjectData.presale,
        totalQuoteRaised: toString(launchpadProjectData.presale.totalQuoteRaised),
        participants: launchpadProjectData.presale.participants.map(p => ({
            ...p,
            quoteAmountContributed: toString(p.quoteAmountContributed),
            tokensAllocated: p.tokensAllocated ? toString(p.tokensAllocated) : undefined,
        }))
      } : undefined,
      feeDetails: launchpadProjectData.feeDetails ? { // If feeDetails were added and had BigInt
          ...launchpadProjectData.feeDetails,
          amount: toString(launchpadProjectData.feeDetails.amount)
      } : undefined
    };

    await new Promise<void>((resolve, reject) => {
        cache.insertOne('launchpads', dbDoc as any, (err, result) => { // Use `as any` due to type mismatch with current LaunchpadDB
            if (err || !result) {
                logger.error(`[launchpad-launch-token] CRITICAL: Failed to save launchpad ${launchpadId}: ${err || 'no result'}.`);
                return reject(err || new Error('Failed to save launchpad'));
            }
            logger.debug(`[launchpad-launch-token] Launchpad ${launchpadId} created for ${data.tokenSymbol}.`);
            resolve();
        });
    });

    const eventDocument = {
      type: 'launchpadLaunchTokenInitiated',
      timestamp: now,
      actor: sender,
      data: {
        launchpadId: launchpadId,
        tokenName: data.tokenName,
        tokenSymbol: data.tokenSymbol,
        totalSupply: toString(data.tokenomics.totalSupply),
        status: launchpadProjectData.status,
      }
    };
    
    await new Promise<void>((resolve) => {
        cache.insertOne('events', eventDocument, (err, result) => {
            if (err || !result) {
                logger.error(`[launchpad-launch-token] CRITICAL: Failed to log event for ${launchpadId}: ${err || 'no result'}.`);
            }
            resolve();
        });
    });

    logger.debug(`[launchpad-launch-token] Launch request for ${data.tokenSymbol} by ${sender} processed successfully. Launchpad ID: ${launchpadId}`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-launch-token] Error processing launch request by ${sender}: ${error}`);
    return false;
  }
} 