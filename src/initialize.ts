
import logger from './logger.js';
import { discoverTransactionHandlers } from './transactions/index.js';

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