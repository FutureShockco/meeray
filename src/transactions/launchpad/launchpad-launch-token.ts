import logger from '../../logger.js';
import cache from '../../cache.js';
import { getAccount, adjustUserBalance } from '../../utils/account.js';
import crypto from 'crypto';
import { logEvent } from '../../utils/event-logger.js';
import {
  LaunchpadLaunchTokenData,
  LaunchpadStatus,
  TokenData,
  LaunchpadData
} from './launchpad-interfaces.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import validate from '../../validation/index.js';
import config from '../../config.js';

function generateLaunchpadId(userId: string, tokenSymbol: string, transactionId?: string): string {
  const txId = transactionId || 'no-tx';
  return `pad-${crypto.createHash('sha256')
    .update(`${userId}_${tokenSymbol}_${txId}`)
    .digest('hex')
    .substring(0, 12)}`;
}

export async function validateTx(data: LaunchpadLaunchTokenData, sender: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Validating launch request from ${sender}`);

  if (sender !== data.userId) {
    logger.warn('[launchpad-launch-token] Sender must match userId for the launch request.');
    return false;
  }

  if (!data.tokenName || !data.tokenSymbol || !data.totalSupply) {
    logger.warn('[launchpad-launch-token] Missing core token information: tokenName, tokenSymbol, totalSupply.');
    return false;
  }

  if (!validate.string(data.tokenSymbol, 10, 3, config.tokenSymbolAllowedChars)) {
    logger.warn('[launchpad-launch-token] Invalid token symbol format.');
    return false;
  }

  if (!validate.string(data.tokenName, 50, 1)) {
    logger.warn('[launchpad-launch-token] Invalid token name (1-50 chars).');
    return false;
  }

  // Check if token symbol already exists
  const existingTokenBySymbol = await cache.findOnePromise('tokens', { symbol: data.tokenSymbol });
  if (existingTokenBySymbol) {
    logger.warn(`[launchpad-launch-token] Token symbol ${data.tokenSymbol} already exists.`);
    return false;
  }

  // Check if there's already a launchpad with this token symbol
  const existingLaunchpad = await cache.findOnePromise('launchpads', { 'tokenToLaunch.symbol': data.tokenSymbol });
  if (existingLaunchpad) {
    logger.warn(`[launchpad-launch-token] Launchpad for token symbol ${data.tokenSymbol} already exists.`);
    return false;
  }

  const decimals = data.tokenDecimals ?? 18;
  if (!validate.integer(decimals, true, false, 18, 0)) {
    logger.warn('[launchpad-launch-token] Invalid tokenDecimals (must be 0-18).');
    return false;
  }

  if (!validate.bigint(data.totalSupply, false, false)) {
    logger.warn('[launchpad-launch-token] Invalid totalSupply. Must be positive.');
    return false;
  }

  // Optional field validations
  if (data.tokenDescription && !validate.string(data.tokenDescription, 1000, 0)) {
    logger.warn('[launchpad-launch-token] tokenDescription too long (max 1000 chars).');
    return false;
  }

  if (data.projectWebsite && (!validate.string(data.projectWebsite, 2048, 10) || !data.projectWebsite.startsWith('http'))) {
    logger.warn('[launchpad-launch-token] Invalid projectWebsite. Must start with http and be <= 2048 chars.');
    return false;
  }

  logger.debug('[launchpad-launch-token] Validation passed (simplified structure).');
  return true;
}

export async function processTx(launchData: LaunchpadLaunchTokenData, sender: string, transactionId: string): Promise<boolean> {
  logger.debug(`[launchpad-launch-token] Processing launch request from ${sender}`);
  
  try {
    const launchpadId = generateLaunchpadId(sender, launchData.tokenSymbol, transactionId);
    const now = new Date().toISOString();
    const tokenDecimalsNumber = launchData.tokenDecimals ?? 18;
    const totalSupplyBigInt = toBigInt(launchData.totalSupply);

    const launchpadProjectData: LaunchpadData = {
      _id: launchpadId,
      projectId: `${launchData.tokenSymbol}-launch-${launchpadId.substring(0, 8)}`,
      status: LaunchpadStatus.UPCOMING,
      tokenToLaunch: {
        name: launchData.tokenName,
        symbol: launchData.tokenSymbol,
        decimals: tokenDecimalsNumber,
        totalSupply: toDbString(totalSupplyBigInt),
      },
      launchedByUserId: sender,
      createdAt: now,
      updatedAt: now,
    };

    // Add optional fields if provided
    if (launchData.tokenDescription) {
      (launchpadProjectData.tokenToLaunch as any).description = launchData.tokenDescription;
    }
    if (launchData.projectWebsite) {
      (launchpadProjectData.tokenToLaunch as any).website = launchData.projectWebsite;
    }

    await new Promise<void>((resolve, reject) => {
      cache.insertOne('launchpads', launchpadProjectData, (err, result) => {
        if (err || !result) {
          logger.error(`[launchpad-launch-token] CRITICAL: Failed to save launchpad ${launchpadId}: ${err || 'no result'}.`);
          return reject(err || new Error('Failed to save launchpad'));
        }
        logger.debug(`[launchpad-launch-token] Launchpad ${launchpadId} created for ${launchData.tokenSymbol}.`);
        resolve();
      });
    });

    logger.debug(`[launchpad-launch-token] Launch request for ${launchData.tokenSymbol} by ${sender} processed successfully. Launchpad ID: ${launchpadId}`);

    await logEvent('launchpad', 'created', sender, {
      launchpadId,
      projectId: launchpadProjectData.projectId,
      tokenName: launchData.tokenName,
      tokenSymbol: launchData.tokenSymbol,
      totalSupply: toDbString(totalSupplyBigInt),
      tokenDecimals: tokenDecimalsNumber,
    });

    return true;

  } catch (error) {
    logger.error(`[launchpad-launch-token] Error processing launch request by ${sender}: ${error}`);
    return false;
  }
} 