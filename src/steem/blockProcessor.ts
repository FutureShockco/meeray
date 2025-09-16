import logger from '../logger.js';
import { chain } from '../chain.js';
import transaction from '../transaction.js';
import parseSteemTransactions, { SteemBlock, SteemBlockResult } from '../steemParser.js';
import { Block } from '../block.js';
import SteemApiClient from './apiClient.js';
import steemConfig from './config.js';

class BlockProcessor {
    private blockCache = new Map<number, SteemBlock>();
    private processingBlocks: number[] = [];
    private consecutiveErrors = 0;
    private retryDelay = steemConfig.minRetryDelay;
    private circuitBreakerOpen = false;
    private prefetchInProgress = false;

    constructor(private apiClient: SteemApiClient) { }

    async processBlock(blockNum: number): Promise<SteemBlockResult | null> {
        const lastProcessedSteemBlockBySidechain = chain.getLatestBlock()?.steemBlockNum || 0;

        logger.debug(`Processing block ${blockNum}, last processed: ${lastProcessedSteemBlockBySidechain}`);

        if (blockNum !== lastProcessedSteemBlockBySidechain + 1) {
            logger.warn(`Block ${blockNum} is not sequential. Expected ${lastProcessedSteemBlockBySidechain + 1}, returning null`);
            return null;
        }

        if (this.processingBlocks.includes(blockNum)) {
            logger.debug(`Block ${blockNum} is already being processed`);
            return null;
        }

        this.processingBlocks.push(blockNum);

        try {
            let steemBlock = this.blockCache.get(blockNum);

            if (!steemBlock) {
                const fetchedBlock = await this.fetchBlockWithRetry(blockNum);
                if (!fetchedBlock) {
                    this.processingBlocks = this.processingBlocks.filter(b => b !== blockNum);
                    return null;
                }
                steemBlock = fetchedBlock;
                this.blockCache.set(blockNum, steemBlock);
                this.cleanupCache();
            }

            const steemBlockResult = await parseSteemTransactions(steemBlock, blockNum);
            this.resetConsecutiveErrors();

            if (steemBlockResult.transactions.length > 0) {
                transaction.addToPool(steemBlockResult.transactions);
            }

            this.processingBlocks = this.processingBlocks.filter(b => b !== blockNum);
            logger.debug(`Block processor returning result for block ${blockNum} with ${steemBlockResult.transactions.length} transactions`);
            return steemBlockResult;
        } catch (error) {
            this.incrementConsecutiveErrors();
            logger.error(`Error processing Steem block ${blockNum}:`, error);
            this.processingBlocks = this.processingBlocks.filter(b => b !== blockNum);
            throw error;
        }
    }

    private async fetchBlockWithRetry(blockNum: number): Promise<SteemBlock | null> {
        const maxAttempts = Math.max(1, 5);
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                logger.debug(`Fetching Steem block ${blockNum} - attempt ${attempt}/${maxAttempts}`);
                const rawSteemBlock = await this.apiClient.getBlock(blockNum);

                if (rawSteemBlock) {
                    this.resetConsecutiveErrors();
                    return {
                        transactions: rawSteemBlock.transactions || [],
                        timestamp: rawSteemBlock.timestamp
                    };
                }
                else {
                    this.incrementConsecutiveErrors();
                    logger.warn(`No data returned for Steem block ${blockNum}`);
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                }
            } catch (error) {
                logger.warn(`Failed to fetch Steem block ${blockNum} (attempt ${attempt}):`, error);

                if (attempt < maxAttempts) {
                    this.apiClient.switchToNextEndpoint();
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                }
            }
        }

        if (this.circuitBreakerOpen) {
            logger.error(`Circuit breaker open - pausing block processing for ${this.retryDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }

        this.incrementConsecutiveErrors();
        return null;
    }

    async prefetchBlocks(startBlockNum: number, isSyncing: boolean): Promise<void> {
        if (this.prefetchInProgress || this.circuitBreakerOpen) return;

        this.prefetchInProgress = true;

        try {
            const latestSteemBlock = await this.apiClient.getLatestBlockNumber();
            if (!latestSteemBlock) {
                logger.warn('Could not fetch latest steem block for prefetch');
                return;
            }

            const localBehind = latestSteemBlock - startBlockNum;
            if (localBehind <= 0) {
                logger.debug('Already caught up with Steem, no blocks to prefetch');
                return;
            }

            const blocksToPrefetch = this.calculatePrefetchCount(localBehind, isSyncing);
            logger.debug(`Prefetching ${blocksToPrefetch} blocks starting from ${startBlockNum} (behind: ${localBehind})`);

            let missedCount = 0;
            for (let i = 0; i < blocksToPrefetch && !this.circuitBreakerOpen; i++) {
                const blockToFetch = startBlockNum + i;

                if (this.processingBlocks.includes(blockToFetch) || this.blockCache.has(blockToFetch)) {
                    continue;
                }

                try {
                    const steemBlock = await this.fetchBlockWithRetry(blockToFetch);
                    if (steemBlock) {
                        this.blockCache.set(blockToFetch, steemBlock);
                    } else {
                        missedCount++;
                    }
                } catch (error) {
                    missedCount++;
                    logger.warn(`Failed to prefetch block ${blockToFetch}:`, error);
                }

                const delay = isSyncing ? steemConfig.syncBlockFetchDelay : steemConfig.syncBlockFetchDelay * 2;
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            if (missedCount > blocksToPrefetch / 2) {
                logger.warn(`Missed ${missedCount}/${blocksToPrefetch} blocks during prefetch`);
                this.apiClient.switchToNextEndpoint();
            }

            this.cleanupCache();
        } catch (error) {
            logger.error('Error in prefetchBlocks:', error);
        } finally {
            this.prefetchInProgress = false;
        }
    }

    private calculatePrefetchCount(localBehind: number, isSyncing: boolean): number {
        if (isSyncing) {
            return Math.min(steemConfig.syncModeBlockFetchBatch, localBehind);
        } else {
            return Math.min(steemConfig.normalModeBlockFetchBatch, localBehind);
        }
    }

    private cleanupCache(): void {
        if (this.blockCache.size > steemConfig.maxPrefetchBlocks * 4) {
            const keysArray = Array.from(this.blockCache.keys()).sort((a, b) => a - b);
            const keysToDelete = keysArray.slice(0, this.blockCache.size - steemConfig.maxPrefetchBlocks * 2);
            keysToDelete.forEach(key => this.blockCache.delete(key));
        }
    }

    async validateBlockAgainstSteem(block: Block): Promise<boolean> {
        try {
            logger.debug(`Validating block ${block._id} against Steem block ${block.steemBlockNum}`);

            let steemBlockData = this.blockCache.get(block.steemBlockNum);
            if (!steemBlockData) {
                const fetchedBlockData = await this.fetchBlockWithRetry(block.steemBlockNum);
                if (!fetchedBlockData) {
                    logger.error(`Could not fetch Steem block ${block.steemBlockNum} for validation`);
                    return false;
                }
                steemBlockData = fetchedBlockData;
                this.blockCache.set(block.steemBlockNum, steemBlockData);
            }

            if (!block.txs || block.txs.length === 0) {
                logger.debug(`Block ${block._id} has no transactions, skipping Steem validation`);
                return true;
            }

            return this.validateTransactions(block, steemBlockData);
        } catch (error) {
            logger.error(`Critical error validating block ${block._id}:`, error);
            return false;
        }
    }

    private validateTransactions(block: Block, steemBlockData: SteemBlock): boolean {
        for (let i = 0; i < block.txs.length; i++) {
            const tx = block.txs[i];

            if (tx.type !== 'custom_json' || tx.data?.id !== 'sidechain') {
                continue; // Only validate sidechain transactions
            }

            let foundOnSteem = false;
            for (const steemTx of steemBlockData.transactions) {
                for (const op of steemTx.operations) {
                    if (!Array.isArray(op) || op[0] !== 'custom_json') continue;

                    const opData = op[1] as any;
                    if (opData?.id === 'sidechain') {
                        try {
                            const jsonData = JSON.parse(opData.json);
                            if (jsonData?.contract === tx.data?.contract &&
                                JSON.stringify(jsonData.payload) === JSON.stringify(tx.data?.payload)) {
                                foundOnSteem = true;
                                break;
                            }
                        } catch (parseErr) {
                            logger.error(`Error parsing JSON in Steem operation:`, parseErr);
                        }
                    }
                }
                if (foundOnSteem) break;
            }

            if (!foundOnSteem) {
                logger.error(`Block ${block._id}, tx #${i}: Transaction NOT FOUND in Steem block ${block.steemBlockNum}`);
                return false;
            }
        }

        logger.info(`Block ${block._id}: All transactions validated against Steem block ${block.steemBlockNum}`);
        return true;
    }

    private incrementConsecutiveErrors(): void {
        this.consecutiveErrors++;
        this.retryDelay = Math.min(this.retryDelay * 1.5, steemConfig.maxRetryDelay);

        if (this.consecutiveErrors >= steemConfig.circuitBreakerThreshold && !this.circuitBreakerOpen) {
            this.circuitBreakerOpen = true;
            logger.error(`Circuit breaker opened after ${this.consecutiveErrors} consecutive errors`);
        }
    }

    private resetConsecutiveErrors(): void {
        if (this.consecutiveErrors > 0) {
            logger.debug(`Reset consecutive errors counter from ${this.consecutiveErrors}`);
            this.consecutiveErrors = 0;
            this.retryDelay = steemConfig.minRetryDelay;
        }

        if (this.circuitBreakerOpen) {
            logger.info('Circuit breaker closed');
            this.circuitBreakerOpen = false;
        }
    }

    // Getters
    isProcessingBlock(blockNum: number): boolean {
        return this.processingBlocks.includes(blockNum);
    }

    isCircuitBreakerOpen(): boolean {
        return this.circuitBreakerOpen;
    }

    getConsecutiveErrors(): number {
        return this.consecutiveErrors;
    }
}

export default BlockProcessor; 