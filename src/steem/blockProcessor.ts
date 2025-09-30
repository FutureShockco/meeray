import { Block } from '../block.js';
import { chain } from '../chain.js';
import config from '../config.js';
import logger from '../logger.js';
import settings from '../settings.js';
import parseSteemTransactions, { SteemBlock, SteemBlockResult } from '../steemParser.js';
import transaction from '../transaction.js';
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

        logger.info(`Processing block ${blockNum}, last processed: ${lastProcessedSteemBlockBySidechain}`);

        if (blockNum !== lastProcessedSteemBlockBySidechain + 1) {
            logger.debug(`Block ${blockNum} is not sequential. Expected ${lastProcessedSteemBlockBySidechain + 1}, returning null`);
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
            logger.info(`Finished parsing Steem block ${blockNum}, found ${steemBlockResult.transactions.length} transactions`);
            this.resetConsecutiveErrors();

            if (steemBlockResult.transactions.length > 0) {
                transaction.addToPool(
                    steemBlockResult.transactions.map((tx, idx) => ({
                        ...tx
                    }))
                );
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
        const maxAttempts = 5;
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
                        timestamp: rawSteemBlock.timestamp,
                    };
                } else {
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

            return this.validateTransactions(block, steemBlockData);
        } catch (error) {
            logger.error(`Critical error validating block ${block._id}:`, error);
            return false;
        }
    }

    private async validateTransactions(block: Block, steemBlockData: SteemBlock): Promise<boolean> {
        const { transactions: validSteemTxs } = await parseSteemTransactions(steemBlockData, block.steemBlockNum) as SteemBlockResult;

        // Extract Steem-derived txs from the sidechain block
        const blockSteemTxs = block.txs.filter(tx => tx.hash && tx.ref && tx.ref.startsWith(`${block.steemBlockNum}:`));
        // Use Steem's transaction_id for comparison
        logger.warn(`Block ${block._id}: Comparing ${validSteemTxs.length} parsed Steem txs with ${blockSteemTxs.length} block Steem-derived txs`);
        logger.warn(`Parsed Steem txs: ${validSteemTxs.map(tx => tx.hash).join(', ')}`);
        logger.warn(`Block Steem-derived txs: ${JSON.stringify(blockSteemTxs)}`);
        const parsedIds = new Set(validSteemTxs.map(tx => tx.hash)); // should be transaction_id
        const blockIds = new Set(blockSteemTxs.map(tx => tx.hash));  // should be transaction_id

        logger.warn(`Parsed ids: ${[...parsedIds].join(', ')}`);
        logger.warn(`Block ids: ${[...blockIds].join(', ')}`);

        if (parsedIds.size !== blockIds.size ||
            ![...parsedIds].every(id => blockIds.has(id))) {
            logger.error(`Block ${block._id}: Steem-derived transactions do not match parsed valid transactions`);
            return false;
        }

        logger.info(`Block ${block._id}: All Steem-derived transactions validated`);
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
