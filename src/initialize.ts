/**
 * This file handles initialization of modules in the correct order to avoid circular dependencies
 */

import logger from './logger.js';
import cache  from './cache.js';
import txHistory from './txHistory.js';
import { transactionHandlers, discoverTransactionHandlers } from './transactions/index.js';

/**
 * Initialize all modules in the correct order
 */
export async function initializeModules() {
  try {
    logger.info('Initializing modules to resolve dependencies');
    
    // Set txHistory in the cache
    await discoverTransactionHandlers();
    logger.info('All modules initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize modules:', error);
    throw error;
  }
}

export default initializeModules; 