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
  Token,
  Launchpad,
  LaunchpadDB
} from './launchpad-interfaces.js';
import { BigIntMath, toString, convertAllBigIntToStringRecursive } from '../../utils/bigint.js'; // Removed convertToString as we'll do it manually for deep objects
import validate from '../../validation/index.js'; // Assuming validate exists
import config from '../../config.js'; // Import config
import { logTransactionEvent } from '../../utils/event-logger.js'; // Import the new event logger


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

  // Ensure data.tokenomics fields are BigInt before use
  // This is important if data comes from an API as JSON (numbers/strings)
  // ValidateTx might have already done this, but good to be defensive
  if (typeof data.tokenomics.tokenDecimals === 'string') {
    try {
      data.tokenomics.tokenDecimals = BigInt(data.tokenomics.tokenDecimals);
    } catch (e) {
      logger.warn('[launchpad-launch-token] Invalid tokenDecimals format, cannot convert to BigInt.');
      return false;
    }
  }
  // Same for totalSupply
  if (typeof data.tokenomics.totalSupply === 'string') {
    try {
      data.tokenomics.totalSupply = BigInt(data.tokenomics.totalSupply);
    } catch (e) {
      logger.warn('[launchpad-launch-token] Invalid totalSupply format, cannot convert to BigInt.');
      return false;
    }
  }

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

export async function process(launchData: LaunchpadLaunchTokenData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Processing launch request from ${sender}`);
  try {
    // Assuming validateTx was called by the node before processing

    const launchpadId = generateLaunchpadId();
    const now = new Date().toISOString();
    
    // Ensure data.tokenomics fields are BigInt before use
    // This is important if data comes from an API as JSON (numbers/strings)
    // ValidateTx might have already done this, but good to be defensive
    const tokenDecimalsBigInt = BigInt(launchData.tokenomics.tokenDecimals);
    const totalSupplyBigInt = BigInt(launchData.tokenomics.totalSupply);

    const tokenDecimalsNumber = BigIntMath.toNumber(tokenDecimalsBigInt);
    if (tokenDecimalsNumber < 0 || tokenDecimalsNumber > 18) {
        logger.error('[launchpad-launch-token] CRITICAL: Invalid token decimals during processing.');
        return false; 
    }

    const launchpadProjectData: Launchpad = {
      _id: launchpadId,
      projectId: `${launchData.tokenSymbol}-launch-${launchpadId.substring(0,8)}`,
      status: LaunchpadStatus.UPCOMING, // Assuming validation passed if we reach here
      tokenToLaunch: {
        name: launchData.tokenName,
        symbol: launchData.tokenSymbol,
        standard: launchData.tokenStandard,
        decimals: tokenDecimalsNumber, // Use converted number
        totalSupply: totalSupplyBigInt, // Use BigInt directly
      },
      tokenomicsSnapshot: {
        ...launchData.tokenomics,
        totalSupply: totalSupplyBigInt, // Ensure BigInt
        tokenDecimals: tokenDecimalsBigInt, // Ensure BigInt
      },
      presaleDetailsSnapshot: launchData.presaleDetails ? {
        ...launchData.presaleDetails,
        // Ensure all BigInt fields are indeed BigInt
        pricePerToken: BigInt(launchData.presaleDetails.pricePerToken),
        minContributionPerUser: BigInt(launchData.presaleDetails.minContributionPerUser),
        maxContributionPerUser: BigInt(launchData.presaleDetails.maxContributionPerUser),
        hardCap: BigInt(launchData.presaleDetails.hardCap),
        softCap: launchData.presaleDetails.softCap ? BigInt(launchData.presaleDetails.softCap) : undefined,
      } : undefined,
      liquidityProvisionDetailsSnapshot: launchData.liquidityProvisionDetails,
      launchedByUserId: sender,
      createdAt: now,
      updatedAt: now,
      feePaid: false, 
      presale: launchData.presaleDetails ? {
          totalQuoteRaised: BigInt(0), // Initialize with BigInt(0)
          participants: [],
          status: 'NOT_STARTED'
      } : undefined,
    };
    
    // Use the recursive converter
    const dbDoc: LaunchpadDB = convertAllBigIntToStringRecursive(launchpadProjectData);

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

    // Log event using the new centralized logger
    const eventData = {
        launchpadId: launchpadId,
        tokenName: launchData.tokenName,
        tokenSymbol: launchData.tokenSymbol,
        totalSupply: toString(totalSupplyBigInt), 
        status: launchpadProjectData.status,
    };
    await logTransactionEvent('launchpadLaunchTokenInitiated', sender, eventData, transactionId);

    logger.debug(`[launchpad-launch-token] Launch request for ${launchData.tokenSymbol} by ${sender} processed successfully. Launchpad ID: ${launchpadId}`);
    return true;

  } catch (error) {
    logger.error(`[launchpad-launch-token] Error processing launch request by ${sender}: ${error}`);
    return false;
  }
} 