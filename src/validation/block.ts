import chain from '../chain.js';
import logger from '../logger.js';

export function blockNumber(blockNum: number | string): boolean {
    const latestBlockId = chain.getLatestBlock().id;
    const num = typeof blockNum === 'string' ? Number(blockNum) : blockNum;

    if (!Number.isInteger(num) || num <= latestBlockId) {
        logger.warn(`[block:validation] blockNum is not valid: ${blockNum}`);
        return false;
    }
    return true;
}