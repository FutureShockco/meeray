import logger from '../../logger.js';
import { processTx as processBuy, validateTx as validateBuyTx } from './nft-buy-item.js';
import { processTx as processDelist, validateTx as validateDelistTx } from './nft-delist-item.js';
import { processTx as processList, validateTx as validateListTx } from './nft-list-item.js';
import { NftBatchPayload } from './nft-market-interfaces.js';
import { processTx as processTransfer, validateTx as validateTransferTx } from './nft-transfer.js';

export async function validateTx(data: NftBatchPayload, sender: string): Promise<boolean> {
    try {
        if (!data.operations?.length || data.operations.length > 50) {
            logger.warn('[nft-batch] Invalid operations array or too many operations (max 50).');
            return false;
        }

        for (let i = 0; i < data.operations.length; i++) {
            const op = data.operations[i];
            if (!op.operation || !op.data) {
                logger.warn(`[nft-batch] Invalid operation at index ${i}.`);
                return false;
            }

            // normalize operation name locally to avoid mutating types
            const opName = String(op.operation).toLowerCase();
            const validOperations = ['list', 'delist', 'buy', 'bid', 'transfer'];
            if (!validOperations.includes(opName)) {
                logger.warn(`[nft-batch] Invalid operation type: ${op.operation}.`);
                return false;
            }

            let isValid = false;
            try {
                switch (opName) {
                    case 'list':
                        isValid = await validateListTx(op.data, sender);
                        break;
                    case 'delist':
                        isValid = await validateDelistTx(op.data, sender);
                        break;
                    case 'buy':
                    case 'bid':
                        isValid = await validateBuyTx(op.data, sender);
                        break;
                    case 'transfer':
                        isValid = await validateTransferTx(op.data, sender);
                        break;
                }
            } catch (error) {
                logger.warn(`[nft-batch] Validation error at index ${i}: ${error}`);
                return false;
            }

            if (!isValid) {
                logger.warn(`[nft-batch] Validation failed for operation ${i}: ${op.operation}.`);
                return false;
            }
        }
        return true;
    } catch (error) {
        logger.error(`[nft-batch] Error validating batch: ${error}`);
        return false;
    }
}
export async function processTx(data: NftBatchPayload, sender: string, id: string, timestamp: number): Promise<boolean> {
    try {
        const isAtomic = data.atomic !== false;

        for (let i = 0; i < data.operations.length; i++) {
            const op = data.operations[i];
            let success = false;

            try {
                const opId = `${id}_${i}`;
                switch (op.operation) {
                    case 'list':
                        success = (await processList(op.data, sender, opId)) !== null;
                        break;
                    case 'delist':
                        success = await processDelist(op.data, sender, opId);
                        break;
                    case 'buy':
                    case 'bid':
                        success = await processBuy(op.data, sender, opId, timestamp);
                        break;
                    case 'transfer':
                        success = await processTransfer(op.data, sender, opId);
                        break;
                }
            } catch (error) {
                logger.error(`[nft-batch] Error processing operation ${i}: ${error}`);
                success = false;
            }

            if (!success && isAtomic) {
                logger.error(`[nft-batch] Operation ${i} failed in atomic mode.`);
                return false;
            }
        }
        return true;
    } catch (error) {
        logger.error(`[nft-batch] Error processing batch: ${error}`);
        return false;
    }
}
