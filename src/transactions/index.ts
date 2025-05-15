import logger from '../logger.js';
import { TransactionType } from './types.js';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL , fileURLToPath } from 'url';
import { extractUsernamesFromTx, upsertAccounts } from '../models/account.js';

// Define the base transaction interface
export interface Transaction {
  id: string;
  type: TransactionType;
  sender: string;
  data: any;
  signature?: string;
  timestamp?: number;
}

// Define transaction handler interface
interface TransactionHandler<T> {
  validate: (data: T, sender: string) => Promise<boolean>;
  process: (data: T, sender: string) => Promise<boolean>;
}

// Create a map of transaction handlers
const transactionHandlers: { [key in TransactionType]?: TransactionHandler<any> } = {};

// Function to recursively search for transaction handlers
async function searchForHandlers(dirPath: string) {
  const files = await fs.readdir(dirPath);
  logger.debug(`Searching directory: ${dirPath}`);
  logger.debug(`Found files: ${files.join(', ')}`);
  
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = await fs.stat(filePath);
    
    if (stats.isDirectory()) {
      // Recursively search subdirectories
      logger.debug(`Entering subdirectory: ${filePath}`);
      await searchForHandlers(filePath);
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      // Skip the index file itself
      if (file === 'index.ts') {
        logger.debug(`Skipping index file: ${filePath}`);
        continue;
      }
      
      logger.info(`Loading transaction handler from: ${filePath}`);
      try {
        const module = await import(pathToFileURL(filePath).href);
        
        // Check if the file exports validate and process functions
        if (module.validate && module.process) {
          // Extract transaction type from filename (e.g., witness-vote.ts -> WITNESS_VOTE)
          const typeName = file
            .replace('.ts', '')
            .split(/[-_]/)  // Split by both hyphen and underscore
            .map(part => part.toUpperCase())
            .join('_');
          
          logger.debug(`Extracted type name from ${file}: ${typeName}`);
          const txType = TransactionType[typeName as keyof typeof TransactionType];
          logger.debug(`Mapped to transaction type: ${txType} (${TransactionType[txType]})`);
          
          if (txType !== undefined) {
            transactionHandlers[txType] = {
              validate: module.validate,
              process: module.process
            };
            logger.info(`Registered transaction handler for ${typeName} (type ${txType})`);
          } else {
            logger.warn(`Failed to map ${typeName} to a valid TransactionType. Available types: ${Object.keys(TransactionType).filter(k => isNaN(Number(k))).join(', ')}`);
            
            // Try alternative mapping - different word boundaries/formats
            const alternativeNames = [
              typeName,
              typeName.replace(/_/g, ''),  // Remove all underscores
              file.replace('.ts', '').toUpperCase(), // Try the raw filename
            ];
            
            // For camelCase files, try to insert underscores between words
            if (file.match(/[a-z][A-Z]/)) {
              const underscoreVersion = file
                .replace('.ts', '')
                .replace(/([a-z])([A-Z])/g, '$1_$2')
                .toUpperCase();
              alternativeNames.push(underscoreVersion);
            }
            
            // Try all alternatives
            let found = false;
            for (const altName of alternativeNames) {
              const altType = TransactionType[altName as keyof typeof TransactionType];
              if (altType !== undefined) {
                transactionHandlers[altType] = {
                  validate: module.validate,
                  process: module.process
                };
                logger.info(`Registered transaction handler for ${typeName} using alternative mapping: ${altName} (type ${altType})`);
                found = true;
                break;
              }
            }
            
            if (!found) {
              logger.warn(`Couldn't find mapping for ${typeName} after trying alternatives: ${alternativeNames.join(', ')}`);
            }
          }
        } else {
          logger.warn(`File ${filePath} doesn't export both validate and process functions. Exports: ${Object.keys(module).join(', ')}`);
        }
      } catch (error) {
        logger.error(`Error importing ${filePath}: ${error}`);
      }
    }
  }
}

// Function to discover and register transaction handlers
async function discoverTransactionHandlers() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    logger.info(`Looking for transaction handlers in ${__dirname}`);
    
    // Start recursive search from the transactions directory
    await searchForHandlers(__dirname);
    
    // Log all registered handlers
    logger.info(`Registered transaction handlers: ${Object.keys(transactionHandlers).map(k => `${k} (${TransactionType[Number(k)]})`).join(', ')}`);
  } catch (error) {
    logger.error('Error discovering transaction handlers:', error);
    throw error;
  }
}

// Initialize transaction handlers
await discoverTransactionHandlers();

/**
 * Process a transaction based on its type
 * 
 * @param tx The transaction to process
 * @returns Promise resolving to the result of processing
 */
export async function processTransaction(tx: Transaction): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate common transaction fields
    if (!tx.id || tx.type === undefined || !tx.sender) {
      logger.warn(`Invalid transaction: missing required fields`);
      return { success: false, error: 'invalid transaction: missing required fields' };
    }
    
    // Extract and ensure all accounts referenced in the transaction exist
    const usernames = extractUsernamesFromTx(tx);
    logger.debug(`Ensuring accounts exist: ${usernames.join(', ')}`);
    await upsertAccounts(usernames);
    
    // Get the handler for this transaction type
    const handler = transactionHandlers[tx.type];
    if (!handler) {
      logger.warn(`Unknown transaction type: ${tx.type} (${TransactionType[tx.type]})`);
      return { success: false, error: `unknown transaction type: ${tx.type}` };
    }
    // Validate the transaction
    const isValid = await handler.validate(tx.data, tx.sender);    
    if (!isValid) {
      logger.warn(`Transaction validation failed for ${tx.id}`);
      return { success: false, error: `invalid ${TransactionType[tx.type].toLowerCase()}` };
    }
    // Process the transaction
    const success = await handler.process(tx.data, tx.sender);    
    if (!success) {
      logger.warn(`Transaction processing failed for ${tx.id}`);
      return { success: false, error: `failed to process ${TransactionType[tx.type].toLowerCase()}` };
    }
    logger.info(`OBSERVER TX DEBUG: Successfully processed transaction ${tx.id}`);
    return { success: true };
  } catch (error) {
    logger.error(`Error processing transaction ${tx.id}: ${error}`);
    return { success: false, error: `internal error: ${error}` };
  }
} 