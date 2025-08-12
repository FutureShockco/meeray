import logger from '../../logger.js';
import cache from '../../cache.js';
// import validate from '../../validation/index.js'; // Assuming a validation library might be used
import { getAccount, adjustBalance } from '../../utils/account.js'; // Assuming account utilities
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
  TokenData,
  LaunchpadData
} from './launchpad-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
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

  if (data.tokenomics.tokenDecimals !== undefined && !validate.integer(data.tokenomics.tokenDecimals, true, false, 18, 0)) {
    logger.warn('[launchpad-launch-token] Invalid tokenDecimals (must be 0-18).');
    return false;
  }

  if (data.tokenomics.totalSupply !== undefined && BigInt(data.tokenomics.totalSupply) < BigInt(0)) {
    logger.warn('[launchpad-launch-token] Invalid totalSupply. Must be non-negative.');
    return false;
  }


  logger.debug('[launchpad-launch-token] Validation passed (structure and basic tokenomics check).');
  return true;
}

export async function process(launchData: LaunchpadLaunchTokenData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Processing launch request from ${sender}`);
  try {
    // Assuming validateTx was called by the node before processing

    const launchpadId = generateLaunchpadId();
    const now = new Date().toISOString();

    // tokenDecimals expected to be a number (validated earlier)
    const tokenDecimalsNumber = Number(launchData.tokenomics.tokenDecimals);
    if (!Number.isInteger(tokenDecimalsNumber) || tokenDecimalsNumber < 0 || tokenDecimalsNumber > 18) {
      logger.error('[launchpad-launch-token] CRITICAL: Invalid token decimals during processing.');
      return false;
    }
    const totalSupplyBigInt = toBigInt(launchData.tokenomics.totalSupply);

    const launchpadProjectData: LaunchpadData = {
      _id: launchpadId,
      projectId: `${launchData.tokenSymbol}-launch-${launchpadId.substring(0, 8)}`,
      status: LaunchpadStatus.UPCOMING, // Assuming validation passed if we reach here
      tokenToLaunch: {
        name: launchData.tokenName,
        symbol: launchData.tokenSymbol,
        standard: launchData.tokenStandard,
        decimals: tokenDecimalsNumber, // Use converted number
        totalSupply: toDbString(totalSupplyBigInt), // Convert to string for storage
      },
      tokenomicsSnapshot: {
        ...launchData.tokenomics,
        tokenDecimals: tokenDecimalsNumber,
        totalSupply: toDbString(totalSupplyBigInt),
      },
      presaleDetailsSnapshot: launchData.presaleDetails ? {
        ...launchData.presaleDetails,
        // Ensure all BigInt fields are indeed BigInt
        pricePerToken: toDbString(toBigInt(launchData.presaleDetails.pricePerToken)),
        minContributionPerUser: toDbString(toBigInt(launchData.presaleDetails.minContributionPerUser)),
        maxContributionPerUser: toDbString(toBigInt(launchData.presaleDetails.maxContributionPerUser)),
        hardCap: toDbString(toBigInt(launchData.presaleDetails.hardCap)),
        softCap: launchData.presaleDetails.softCap !== undefined ? toDbString(toBigInt(launchData.presaleDetails.softCap)) : undefined,
      } : undefined,
      liquidityProvisionDetailsSnapshot: launchData.liquidityProvisionDetails,
      launchedByUserId: sender,
      createdAt: now,
      updatedAt: now,
      feePaid: false,
      presale: launchData.presaleDetails ? {
        totalQuoteRaised: '0', // Initialize with string '0'
        participants: [],
        status: 'NOT_STARTED'
      } : undefined,
    };

    // Save to database with string conversion for storage
    const dbDoc: LaunchpadData = {
      ...launchpadProjectData,
      tokenomicsSnapshot: {
        ...launchpadProjectData.tokenomicsSnapshot,
        totalSupply: toDbString(toBigInt(launchpadProjectData.tokenomicsSnapshot.totalSupply as any)),
        tokenDecimals: tokenDecimalsNumber as unknown as any
      }
    };

    await new Promise<void>((resolve, reject) => {
      cache.insertOne('launchpads', dbDoc, (err, result) => { // No more 'as any'
        if (err || !result) {
          logger.error(`[launchpad-launch-token] CRITICAL: Failed to save launchpad ${launchpadId}: ${err || 'no result'}.`);
          return reject(err || new Error('Failed to save launchpad'));
        }
        logger.debug(`[launchpad-launch-token] Launchpad ${launchpadId} created for ${launchData.tokenSymbol}.`);
        resolve();
      });
    });


    logger.debug(`[launchpad-launch-token] Launch request for ${launchData.tokenSymbol} by ${sender} processed successfully. Launchpad ID: ${launchpadId}`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-launch-token] Error processing launch request by ${sender}: ${error}`);
    return false;
  }
} 