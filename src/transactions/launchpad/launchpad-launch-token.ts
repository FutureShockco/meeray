import logger from '../../logger.js';
import cache from '../../cache.js';
// import validate from '../../validation/index.js'; // Assuming a validation library might be used
import { getAccount, adjustBalance } from '../../utils/account.js'; // Assuming account utilities
import crypto from 'crypto';
import { logTransactionEvent } from '../../utils/event-logger.js';
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

  if (data.tokenomics.totalSupply === undefined || !validate.bigint(data.tokenomics.totalSupply, false, false)) {
    logger.warn('[launchpad-launch-token] Invalid totalSupply. Must be positive.');
    return false;
  }

  // Optional: basic name
  if (!validate.string(data.tokenName, 50, 1)) {
    logger.warn('[launchpad-launch-token] Invalid token name (1-50 chars).');
    return false;
  }

  // Validate allocations percentage sum <= 100
  if (Array.isArray(data.tokenomics.allocations)) {
    let sum = 0;
    for (const alloc of data.tokenomics.allocations) {
      if (alloc.percentage < 0 || alloc.percentage > 100) {
        logger.warn('[launchpad-launch-token] Allocation percentage out of range 0-100.');
        return false;
      }
      sum += alloc.percentage;
    }
    if (sum > 100) {
      logger.warn('[launchpad-launch-token] Total allocation percentages exceed 100.');
      return false;
    }
  }

  // Presale validation if present
  if (data.presaleDetails) {
    const p = data.presaleDetails as PresaleDetails;
    if (!validate.string(p.quoteAssetForPresaleSymbol, 10, 1, config.tokenSymbolAllowedChars)) {
      logger.warn('[launchpad-launch-token] Invalid quoteAssetForPresaleSymbol.');
      return false;
    }
    if (p.quoteAssetForPresaleIssuer && !validate.string(p.quoteAssetForPresaleIssuer, 16, 3)) {
      logger.warn('[launchpad-launch-token] Invalid quoteAssetForPresaleIssuer.');
      return false;
    }
    if (!validate.bigint(p.pricePerToken, false, false)) {
      logger.warn('[launchpad-launch-token] Invalid pricePerToken.');
      return false;
    }
    if (!validate.bigint(p.minContributionPerUser, true, false)) {
      logger.warn('[launchpad-launch-token] Invalid minContributionPerUser.');
      return false;
    }
    if (!validate.bigint(p.maxContributionPerUser, false, false)) {
      logger.warn('[launchpad-launch-token] Invalid maxContributionPerUser.');
      return false;
    }
    if (toBigInt(p.maxContributionPerUser) < toBigInt(p.minContributionPerUser)) {
      logger.warn('[launchpad-launch-token] maxContributionPerUser must be >= minContributionPerUser.');
      return false;
    }
    if (!validate.bigint(p.hardCap, false, false)) {
      logger.warn('[launchpad-launch-token] Invalid hardCap.');
      return false;
    }
    if (p.softCap !== undefined && !validate.bigint(p.softCap, true, false)) {
      logger.warn('[launchpad-launch-token] Invalid softCap.');
      return false;
    }
    if (p.softCap !== undefined && toBigInt(p.softCap) > toBigInt(p.hardCap)) {
      logger.warn('[launchpad-launch-token] softCap cannot exceed hardCap.');
      return false;
    }
    const startMs = Date.parse(p.startTime);
    const endMs = Date.parse(p.endTime);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      logger.warn('[launchpad-launch-token] Invalid startTime/endTime.');
      return false;
    }
    if (p.presaleTokenAllocationPercentage < 0 || p.presaleTokenAllocationPercentage > 100) {
      logger.warn('[launchpad-launch-token] presaleTokenAllocationPercentage out of range 0-100.');
      return false;
    }
  }

  // Optional descriptive fields
  if (data.tokenDescription && !validate.string(data.tokenDescription, 1000, 0)) {
    logger.warn('[launchpad-launch-token] tokenDescription too long (max 1000 chars).');
    return false;
  }
  if (data.tokenLogoUrl && (!validate.string(data.tokenLogoUrl, 2048, 10) || !data.tokenLogoUrl.startsWith('http'))) {
    logger.warn('[launchpad-launch-token] Invalid tokenLogoUrl. Must start with http and be <= 2048 chars.');
    return false;
  }
  if (data.projectWebsite && (!validate.string(data.projectWebsite, 2048, 10) || !data.projectWebsite.startsWith('http'))) {
    logger.warn('[launchpad-launch-token] Invalid projectWebsite. Must start with http and be <= 2048 chars.');
    return false;
  }
  if (data.projectSocials) {
    for (const [platform, url] of Object.entries(data.projectSocials)) {
      if (!validate.string(platform, 32, 1)) {
        logger.warn('[launchpad-launch-token] Invalid projectSocials key.');
        return false;
      }
      if (!validate.string(url, 2048, 10) || !url.startsWith('http')) {
        logger.warn('[launchpad-launch-token] Invalid projectSocials URL.');
        return false;
      }
    }
  }

  // Launch fee token identifiers
  if (!validate.string(data.launchFeeTokenSymbol, 10, 1, config.tokenSymbolAllowedChars)) {
    logger.warn('[launchpad-launch-token] Invalid launchFeeTokenSymbol.');
    return false;
  }
  if (data.launchFeeTokenIssuer && !validate.string(data.launchFeeTokenIssuer, 16, 3)) {
    logger.warn('[launchpad-launch-token] Invalid launchFeeTokenIssuer.');
    return false;
  }

  // Vesting schedule validations within allocations
  if (Array.isArray(data.tokenomics.allocations)) {
    for (const alloc of data.tokenomics.allocations) {
      const vs = alloc.vestingSchedule;
      if (vs) {
        if (!validate.integer(vs.durationMonths, false, false)) {
          logger.warn('[launchpad-launch-token] Invalid vesting durationMonths.');
          return false;
        }
        if (vs.cliffMonths !== undefined && !validate.integer(vs.cliffMonths, true, false)) {
          logger.warn('[launchpad-launch-token] Invalid vesting cliffMonths.');
          return false;
        }
        if (vs.cliffMonths !== undefined && (vs.cliffMonths as number) > (vs.durationMonths as number)) {
          logger.warn('[launchpad-launch-token] vesting cliffMonths cannot exceed durationMonths.');
          return false;
        }
        if (vs.initialUnlockPercentage !== undefined && (vs.initialUnlockPercentage < 0 || vs.initialUnlockPercentage > 100)) {
          logger.warn('[launchpad-launch-token] vesting initialUnlockPercentage out of range 0-100.');
          return false;
        }
      }
      if (alloc.lockupMonths !== undefined && !validate.integer(alloc.lockupMonths, true, false)) {
        logger.warn('[launchpad-launch-token] Invalid lockupMonths.');
        return false;
      }
      if (alloc.customRecipientAddress && !validate.string(alloc.customRecipientAddress, 64, 3)) {
        logger.warn('[launchpad-launch-token] Invalid customRecipientAddress.');
        return false;
      }
    }
  }

  // Cross-consistency checks: ensure tokenomics allocation covers presale/liquidity percentages
  if (data.presaleDetails && Array.isArray(data.tokenomics.allocations)) {
    const presaleAlloc = data.tokenomics.allocations.find(a => a.recipient === TokenDistributionRecipient.PRESALE_PARTICIPANTS);
    if (!presaleAlloc || presaleAlloc.percentage < data.presaleDetails.presaleTokenAllocationPercentage) {
      logger.warn('[launchpad-launch-token] PRESALE_PARTICIPANTS allocation must be >= presaleTokenAllocationPercentage.');
      return false;
    }
  }
  if (data.liquidityProvisionDetails && Array.isArray(data.tokenomics.allocations)) {
    const lpAlloc = data.tokenomics.allocations.find(a => a.recipient === TokenDistributionRecipient.LIQUIDITY_POOL);
    if (!lpAlloc || lpAlloc.percentage < data.liquidityProvisionDetails.liquidityTokenAllocationPercentage) {
      logger.warn('[launchpad-launch-token] LIQUIDITY_POOL allocation must be >= liquidityTokenAllocationPercentage.');
      return false;
    }
  }


  logger.debug('[launchpad-launch-token] Validation passed (structure and basic tokenomics check).');
  return true;
}

export async function process(launchData: LaunchpadLaunchTokenData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Processing launch request from ${sender}`);
  try {
    // validateTx ensures data correctness; process here should not re-validate
    const launchpadId = generateLaunchpadId();
    const now = new Date().toISOString();

    // tokenDecimals expected to be a number (validated earlier)
    const tokenDecimalsNumber = Number(launchData.tokenomics.tokenDecimals);
    // tokenDecimals already validated
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

    // Log event
    await logTransactionEvent('launchpad_created', sender, {
      launchpadId,
      projectId: launchpadProjectData.projectId,
      tokenName: launchData.tokenName,
      tokenSymbol: launchData.tokenSymbol,
      tokenStandard: launchData.tokenStandard,
      totalSupply: toDbString(totalSupplyBigInt),
      tokenDecimals: tokenDecimalsNumber,
      presaleDetails: launchData.presaleDetails ? {
        pricePerToken: toDbString(toBigInt(launchData.presaleDetails.pricePerToken)),
        hardCap: toDbString(toBigInt(launchData.presaleDetails.hardCap)),
        softCap: launchData.presaleDetails.softCap ? toDbString(toBigInt(launchData.presaleDetails.softCap)) : undefined
      } : undefined,
      liquidityProvisionDetails: launchData.liquidityProvisionDetails
    });

    return true;

  } catch (error) {
    logger.error(`[launchpad-launch-token] Error processing launch request by ${sender}: ${error}`);
    return false;
  }
} 