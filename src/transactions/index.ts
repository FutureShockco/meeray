import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import logger from '../logger.js';
import { TransactionType } from './types.js';

// Define the base transaction interface
export interface Transaction {
    hash?: any;
    type: TransactionType;
    sender: string;
    data: any;
    signature?: string;
    id: string; // Unique transaction ID
    ts?: number;
}

// Define transaction handler interface
interface TransactionHandler<T> {
    validate: (data: T, sender: string, id: string, ts?: number) => Promise<boolean>;
    // ts is optional to preserve backward compatibility; when provided, it is the tx timestamp from Steem
    process: (data: T, sender: string, id: string, ts?: number) => Promise<boolean>;
}

// Create a map of transaction handlers
const transactionHandlers: { [key in TransactionType]?: TransactionHandler<any> } = {};

// Function to recursively search for transaction handlers
async function searchForHandlers(dirPath: string) {
    const files = await fs.readdir(dirPath);
    logger.trace(`Searching directory: ${dirPath}`);
    logger.trace(`Found files: ${files.join(', ')}`);

    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);

        if (stats.isDirectory()) {
            // Recursively search subdirectories
            logger.trace(`Entering subdirectory: ${filePath}`);
            await searchForHandlers(filePath);
        } else if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')) {
            // Skip the index file itself and utility files
            if (
                file === 'index.ts' ||
                file === 'index.js' ||
                file.includes('interfaces') ||
                file.includes('processor') ||
                file.includes('helpers') ||
                file === 'orderbook.ts' ||
                file === 'orderbook.js' ||
                file === 'matching-engine.ts' ||
                file === 'matching-engine.js' ||
                file === 'market-aggregator.ts' ||
                file === 'market-aggregator.js' ||
                file === 'types.ts' ||
                file === 'types.js'
            ) {
                logger.trace(`Skipping index, interface, or utility files: ${filePath}`);
                continue;
            }

            logger.trace(`Loading transaction handler from: ${filePath}`);
            try {
                // If we're looking at a TypeScript source file, prefer importing the
                // corresponding compiled JavaScript in `build/dist` or `dist` when
                // available. This prevents Node from attempting to resolve `.js`
                // imports relative to `src/` (e.g. `../../utils/account.js`) where
                // only `.ts` files exist.
                let importTargetPath = filePath;
                if (file.endsWith('.ts')) {
                    // Candidate 1: build/dist counterpart
                    const cand1 = filePath.replace(`${path.sep}src${path.sep}`, `${path.sep}build${path.sep}dist${path.sep}`).replace(/\.ts$/, '.js');
                    try {
                        const stats = await fs.stat(cand1);
                        if (stats.isFile()) {
                            importTargetPath = cand1;
                        }
                    } catch (e) {
                        // ignore -- fallback to next candidate
                    }

                    if (importTargetPath === filePath) {
                        // Candidate 2: dist counterpart
                        const cand2 = filePath.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`).replace(/\.ts$/, '.js');
                        try {
                            const stats2 = await fs.stat(cand2);
                            if (stats2.isFile()) {
                                importTargetPath = cand2;
                            }
                        } catch (e) {
                            // ignore -- will fall back to importing the .ts file directly
                        }
                    }
                }

                const module = await import(pathToFileURL(importTargetPath).href);

                // Check if the file exports validate and process functions
                if (module.validateTx && module.processTx) {
                    // Extract transaction type from filename (e.g., witness-vote.ts -> WITNESS_VOTE)
                    const typeName = file
                        .replace(/\.(ts|js)$/, '')
                        .split(/[-_]/) // Split by both hyphen and underscore
                        .map(part => part.toUpperCase())
                        .join('_');

                    logger.trace(`Extracted type name from ${file}: ${typeName}`);
                    const txType = TransactionType[typeName as keyof typeof TransactionType];
                    logger.trace(`Mapped to transaction type: ${txType} (${TransactionType[txType]})`);

                    if (txType !== undefined) {
                        transactionHandlers[txType] = {
                            validate: module.validateTx,
                            process: module.processTx,
                        };
                        logger.trace(`Registered transaction handler for ${typeName} (type ${txType})`);
                    } else {
                        logger.warn(
                            `Failed to map ${typeName} to a valid TransactionType. Available types: ${Object.keys(TransactionType)
                                .filter(k => isNaN(Number(k)))
                                .join(', ')}`
                        );

                        // Try alternative mapping - different word boundaries/formats
                        const alternativeNames = [
                            typeName,
                            typeName.replace(/_/g, ''), // Remove all underscores
                            file.replace(/\.(ts|js)$/, '').toUpperCase(), // Try the raw filename
                        ];

                        // For camelCase files, try to insert underscores between words
                        if (file.match(/[a-z][A-Z]/)) {
                            const underscoreVersion = file
                                .replace(/\.(ts|js)$/, '')
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
                                    validate: module.validateTx,
                                    process: module.processTx,
                                };
                                logger.debug(
                                    `Registered transaction handler for ${typeName} using alternative mapping: ${altName} (type ${altType})`
                                );
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            logger.warn(
                                `Couldn't find mapping for ${typeName} after trying alternatives: ${alternativeNames.join(', ')}`
                            );
                        }
                    }
                } else {
                    logger.warn(
                        `File ${filePath} doesn't export both validate and process functions. Exports: ${Object.keys(module).join(', ')}`
                    );
                }
            } catch (error) {
                logger.error(`Error importing ${filePath}: ${error}`);
            }
        }
    }
}

// Function to discover and register transaction handlers
export async function discoverTransactionHandlers() {
    try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        logger.trace(`Looking for transaction handlers in ${__dirname}`);

        // Start recursive search from the transactions directory
        await searchForHandlers(__dirname);

        // Log all registered handlers
        logger.trace(
            `Registered transaction handlers: ${Object.keys(transactionHandlers)
                .map(k => `${k} (${TransactionType[Number(k)]})`)
                .join(', ')}`
        );
    } catch (error) {
        logger.error('Error discovering transaction handlers:', error);
        throw error;
    }
}

// EXPORT the transactionHandlers map
export { transactionHandlers };

/**
 * Process a transaction based on its type
 *
 * @param tx The transaction to process
 * @returns Promise resolving to the result of processing
 */
export async function processTransaction(tx: Transaction): Promise<{ success: boolean; error?: string }> {
    try {
        // Validate common transaction fields
        if (tx.type === undefined || !tx.sender) {
            logger.warn(`Invalid transaction: missing required fields`);
            return { success: false, error: 'invalid transaction: missing required fields' };
        }

        // Get the handler for this transaction type
        const handler = transactionHandlers[tx.type];
        if (!handler) {
            logger.warn(`Unknown transaction type: ${tx.type} (${TransactionType[tx.type]})`);
            return { success: false, error: `unknown transaction type: ${tx.type}` };
        }

        // Validate the transaction
        const isValid = await handler.validate(tx.data, tx.sender, tx.id, tx.ts);
        if (!isValid) {
            logger.warn(`Transaction validation failed for ${tx.type}`);
            // Provide a more specific error if the handler.validate itself throws or returns a string error
            // For now, using a generic message based on the boolean.
            // If handler.validate can return a reason for failure, that would be better to propagate.
            return { success: false, error: `invalid ${TransactionType[tx.type].toLowerCase()} transaction data` };
        }

        logger.debug(`Transaction validated successfully (not executed): ${TransactionType[tx.type]} from ${tx.sender}`);
        return { success: true }; // Now only indicates validation success
    } catch (error) {
        logger.error(`Error validating transaction ${tx.type}: ${error}`);
        // Adjust error message if handler.validate throws
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: `internal error during validation: ${errorMessage}` };
    }
}
