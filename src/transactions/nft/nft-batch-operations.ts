import logger from '../../logger.js';
import { processTx as processBuy, validateTx as validateBuyTx } from './nft-buy-item.js';
import { processTx as processDelist, validateTx as validateDelistTx } from './nft-delist-item.js';
import { processTx as processList, validateTx as validateListTx } from './nft-list-item.js';
import { NftBatchPayload } from './nft-market-interfaces.js';
import { processTx as processTransfer, validateTx as validateTransferTx } from './nft-transfer.js';

export async function validateTx(data: NftBatchPayload, sender: string): Promise<{ valid: boolean; error?: string }> {
    try {
        if (!data.operations?.length || data.operations.length > 50) {
            logger.warn('[nft-batch] Invalid operations array or too many operations (max 50).');
            return { valid: false, error: 'invalid operations array or too many operations' };
        }

        for (let i = 0; i < data.operations.length; i++) {
            const op = data.operations[i];
            if (!op.operation || !op.data) {
                logger.warn(`[nft-batch] Invalid operation at index ${i}.`);
                return { valid: false, error: 'invalid operation' };
            }

            // normalize operation name locally to avoid mutating types
            const opName = String(op.operation).toLowerCase();
            const validOperations = ['LIST', 'DELIST', 'BUY', 'BID', 'TRANSFER'];
            if (!validOperations.includes(opName)) {
                logger.warn(`[nft-batch] Invalid operation type: ${op.operation}.`);
                return { valid: false, error: 'invalid operation type' };
            }

            let isValid = { valid: false };
            try {
                switch (opName) {
                    case 'LIST':
                        isValid = await validateListTx(op.data, sender);
                        break;
                    case 'DELIST':
                        isValid = await validateDelistTx(op.data, sender);
                        break;
                    case 'BUY':
                    case 'BID':
                        isValid = await validateBuyTx(op.data, sender);
                        break;
                    case 'TRANSFER':
                        isValid = await validateTransferTx(op.data, sender);
                        break;
                }
            } catch (error) {
                logger.warn(`[nft-batch] Validation error at index ${i}: ${error}`);
                return { valid: false, error: 'validation error' };
            }

            if (!isValid) {
                logger.warn(`[nft-batch] Validation failed for operation ${i}: ${op.operation}.`);
                return { valid: false, error: 'validation failed' };
            }
        }
        return { valid: true };
    } catch (error) {
        logger.error(`[nft-batch] Error validating batch: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
export async function processTx(data: NftBatchPayload, sender: string, id: string, timestamp: number): Promise<{ valid: boolean; error?: string }> {
    try {
        const isAtomic = data.atomic !== false;

        for (let i = 0; i < data.operations.length; i++) {
            const op = data.operations[i];
            let success = { valid: false };

            try {
                const opId = `${id}_${i}`;
                switch (op.operation) {
                    case 'LIST':
                        success = { valid: (await processList(op.data, sender, opId)) !== null };
                        break;
                    case 'DELIST':
                        success = { valid: await processDelist(op.data, sender, opId) !== null };
                        break;
                    case 'BUY':
                    case 'BID':
                        success = { valid: await processBuy(op.data, sender, opId, timestamp) !== null };
                        break;
                    case 'TRANSFER':
                        success = { valid: await processTransfer(op.data, sender, opId) !== null };
                        break;
                }
            } catch (error) {
                logger.error(`[nft-batch] Error processing operation ${i}: ${error}`);
                success = { valid: false };
            }

            if (!success.valid && isAtomic) {
                logger.error(`[nft-batch] Operation ${i} failed in atomic mode.`);
                return { valid: false, error: 'operation failed in atomic mode' };
            }
        }
        return { valid: true };
    } catch (error) {
        logger.error(`[nft-batch] Error processing batch: ${error}`);
        return { valid: false, error: 'internal error' };
    }
}
