import logger from '../../logger.js';
import cache from '../../cache.js';
import validate from '../../validation/index.js';
import { NftBatchPayload, NftBatchOperation } from './nft-market-interfaces.js';

// Import individual transaction processors
import { validateTx as validateListTx, process as processList } from './nft-list-item.js';
import { validateTx as validateDelistTx, process as processDelist } from './nft-delist-item.js';
import { validateTx as validateBuyTx, process as processBuy } from './nft-buy-item.js';
import { validateTx as validateTransferTx, process as processTransfer } from './nft-transfer.js';

export async function validateTx(data: NftBatchPayload, sender: string): Promise<boolean> {
  try {
    if (!data.operations || !Array.isArray(data.operations)) {
      logger.warn('[nft-batch] Invalid data: Missing operations array.');
      return false;
    }

    if (data.operations.length === 0) {
      logger.warn('[nft-batch] Invalid data: Empty operations array.');
      return false;
    }

    if (data.operations.length > 50) { // Reasonable limit to prevent abuse
      logger.warn('[nft-batch] Too many operations in batch. Maximum 50 allowed.');
      return false;
    }

    // Validate each operation
    for (let i = 0; i < data.operations.length; i++) {
      const operation = data.operations[i];
      
      if (!operation.operation || !operation.data) {
        logger.warn(`[nft-batch] Invalid operation at index ${i}: Missing operation type or data.`);
        return false;
      }

      // Validate operation type
      const validOperations = ['LIST', 'DELIST', 'BUY', 'BID', 'TRANSFER'];
      if (!validOperations.includes(operation.operation)) {
        logger.warn(`[nft-batch] Invalid operation type at index ${i}: ${operation.operation}. Must be one of: ${validOperations.join(', ')}.`);
        return false;
      }

      // Validate individual operation data using respective validators
      let isValid = false;
      try {
        switch (operation.operation) {
          case 'LIST':
            isValid = await validateListTx(operation.data, sender);
            break;
          case 'DELIST':
            isValid = await validateDelistTx(operation.data, sender);
            break;
          case 'BUY':
          case 'BID':
            isValid = await validateBuyTx(operation.data, sender);
            break;
          case 'TRANSFER':
            isValid = await validateTransferTx(operation.data, sender);
            break;
          default:
            isValid = false;
        }
      } catch (error) {
        logger.warn(`[nft-batch] Error validating operation at index ${i}: ${error}`);
        isValid = false;
      }

      if (!isValid) {
        logger.warn(`[nft-batch] Validation failed for operation at index ${i}: ${operation.operation}.`);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error(`[nft-batch] Error validating batch operations: ${error}`);
    return false;
  }
}

export async function process(data: NftBatchPayload, sender: string, id: string): Promise<boolean> {
  const results: Array<{ operation: string; index: number; success: boolean; error?: string }> = [];
  const isAtomic = data.atomic !== false; // Default to atomic
  
  try {
    logger.debug(`[nft-batch] Processing ${data.operations.length} operations in ${isAtomic ? 'atomic' : 'non-atomic'} mode.`);

    // Process each operation
    for (let i = 0; i < data.operations.length; i++) {
      const operation = data.operations[i];
      let success = false;
      let error: string | undefined;

      try {
        const operationId = `${id}-${i}`;
        
        switch (operation.operation) {
          case 'LIST':
            const listResult = await processList(operation.data, sender, operationId);
            success = listResult !== null;
            if (!success) {
              error = 'Failed to process list operation';
            }
            break;
            
          case 'DELIST':
            success = await processDelist(operation.data, sender, operationId);
            if (!success) {
              error = 'Failed to process delist operation';
            }
            break;
            
          case 'BUY':
          case 'BID':
            success = await processBuy(operation.data, sender, operationId);
            if (!success) {
              error = 'Failed to process buy/bid operation';
            }
            break;
            
          case 'TRANSFER':
            success = await processTransfer(operation.data, sender, operationId);
            if (!success) {
              error = 'Failed to process transfer operation';
            }
            break;
            
          default:
            success = false;
            error = `Unsupported operation: ${operation.operation}`;
        }
        
      } catch (operationError: any) {
        success = false;
        error = operationError.message || 'Unknown error';
        logger.error(`[nft-batch] Error processing operation ${i} (${operation.operation}): ${operationError}`);
      }

      results.push({
        operation: operation.operation,
        index: i,
        success,
        error
      });

      // If atomic mode and any operation fails, rollback and return false
      if (isAtomic && !success) {
        logger.error(`[nft-batch] Operation ${i} failed in atomic mode. Batch will be rolled back.`);


        return false;
      }
    }

    // Count successes and failures
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    
    logger.debug(`[nft-batch] Batch completed. Successes: ${successCount}, Failures: ${failureCount}`);

    // In non-atomic mode, partial success is still considered success
    const batchSuccess = isAtomic ? failureCount === 0 : successCount > 0;


    return batchSuccess;

  } catch (error) {
    logger.error(`[nft-batch] Error processing batch operations: ${error}`);
    

    return false;
  }
}

// Helper function to estimate gas/complexity for batch operations
export function estimateBatchComplexity(operations: NftBatchOperation[]): number {
  let complexity = 0;
  
  for (const operation of operations) {
    switch (operation.operation) {
      case 'LIST':
        complexity += 10; // Database write + validation
        break;
      case 'DELIST':
        complexity += 5; // Simple database update
        break;
      case 'BUY':
      case 'BID':
        complexity += 20; // Token transfers + multiple database operations
        break;
      case 'TRANSFER':
        complexity += 15; // NFT ownership transfer + validation
        break;
      default:
        complexity += 5; // Unknown operation baseline
    }
  }
  
  return complexity;
}

// Helper function to validate batch size and complexity
export function validateBatchConstraints(operations: NftBatchOperation[]): { valid: boolean; reason?: string } {
  if (operations.length > 50) {
    return { valid: false, reason: 'Too many operations (max 50)' };
  }
  
  const complexity = estimateBatchComplexity(operations);
  if (complexity > 500) { // Arbitrary complexity limit
    return { valid: false, reason: 'Batch too complex (estimated complexity > 500)' };
  }
  
  // Check for conflicting operations (e.g., list and delist same NFT)
  const listingIds = new Set<string>();
  const nftIds = new Set<string>();
  
  for (const operation of operations) {
    if (operation.operation === 'LIST' && operation.data.collectionSymbol && operation.data.instanceId) {
      const nftId = `${operation.data.collectionSymbol}-${operation.data.instanceId}`;
      if (nftIds.has(nftId)) {
        return { valid: false, reason: `Conflicting operations for NFT ${nftId}` };
      }
      nftIds.add(nftId);
    }
    
    if ((operation.operation === 'DELIST' || operation.operation === 'BUY') && operation.data.listingId) {
      if (listingIds.has(operation.data.listingId)) {
        return { valid: false, reason: `Conflicting operations for listing ${operation.data.listingId}` };
      }
      listingIds.add(operation.data.listingId);
    }
  }
  
  return { valid: true };
}
