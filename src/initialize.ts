import logger from './logger.js';
import { discoverTransactionHandlers } from './transactions/index.js';

/**
 * Initializes modules to resolve dependencies.
 * This function is called at the start of the application to ensure all modules are ready.
 */
export async function initializeModules() {
    try {
        logger.info('Initializing modules to resolve dependencies');
        await discoverTransactionHandlers();
        logger.info('All modules initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize modules:', error);
        throw error;
    }
}

export default initializeModules;
