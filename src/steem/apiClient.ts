import { Client as DsteemClient } from 'dsteem';
import logger from '../logger.js';
import config from '../config.js';
import steemConfig from './config.js';

interface RpcHeightData {
    height: number;
    timestamp: number;
}

class SteemApiClient {
    private client: any;
    private currentEndpointIndex = 0;
    private apiUrls: string[];
    private rpcHeightData = new Map<string, RpcHeightData>();

    constructor() {
        this.apiUrls = process.env.STEEM_API
            ? process.env.STEEM_API.split(',').map(url => url.trim())
            : steemConfig.defaultSteemEndpoints;

        this.initializeClient();
    }

    private initializeClient(): void {
        if (process.env.NODE_ENV === 'production') {
            this.client = new DsteemClient(this.apiUrls[this.currentEndpointIndex], {
                addressPrefix: 'STM',
                chainId: '0000000000000000000000000000000000000000000000000000000000000000',
                timeout: 15000
            });
        } else {
            this.client = new DsteemClient("https://testapi.moecki.online", {
                addressPrefix: 'MTN',
                chainId: '1aa939649afcc54c67e01a809967f75b8bee5d928aa6bdf237d0d5d6bfbc5c22',
                timeout: 15000
            });
        }
    }

    switchToNextEndpoint(): boolean {
        if (this.apiUrls.length <= 1) return false;

        // Try to find the best endpoint based on cached heights
        let bestEndpoint = this.apiUrls[0];
        let highestBlock = 0;
        for (const [url, data] of this.rpcHeightData.entries()) {
            if (this.apiUrls.includes(url) && data.height > highestBlock) {
                highestBlock = data.height;
                bestEndpoint = url;
            }
        }

        if (bestEndpoint !== this.client.address) {
            logger.info(`Switching to better Steem API endpoint: ${bestEndpoint}`);
            this.client = new DsteemClient(bestEndpoint, {
                addressPrefix: 'STM',
                chainId: config.steemChainId || '0000000000000000000000000000000000000000000000000000000000000000',
                timeout: 15000
            });
            return true;
        }

        this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.apiUrls.length;
        const newEndpoint = this.apiUrls[this.currentEndpointIndex];
        logger.info(`Switching to next Steem API endpoint: ${newEndpoint}`);
        
        this.client = new DsteemClient(newEndpoint, {
            addressPrefix: 'STM',
            chainId: config.steemChainId || '0000000000000000000000000000000000000000000000000000000000000000',
            timeout: 15000
        });
        return true;
    }

    async getLatestBlockNumber(): Promise<number | null> {
        try {
            const now = Date.now();
            let highestCachedBlock = 0;
            
            for (const data of this.rpcHeightData.values()) {
                if (now - data.timestamp < 10000 && data.height > highestCachedBlock) {
                    highestCachedBlock = data.height;
                }
            }
            
            if (highestCachedBlock > 0) {
                return highestCachedBlock;
            }

            const dynGlobalProps = await this.client.database.getDynamicGlobalProperties();
            if (dynGlobalProps?.head_block_number) {
                this.rpcHeightData.set(this.client.address, {
                    height: dynGlobalProps.head_block_number,
                    timestamp: Date.now()
                });
                return dynGlobalProps.head_block_number;
            }
            
            throw new Error('Invalid response from getDynamicGlobalProperties');
        } catch (error) {
            logger.warn('Error getting latest Steem block number:', error);
            if (this.switchToNextEndpoint()) {
                return this.getLatestBlockNumber(); // Retry with new endpoint
            }
            return null;
        }
    }

    async getBlock(blockNum: number): Promise<any> {
        return this.client.database.getBlock(blockNum);
    }

    getCurrentAddress(): string {
        return this.client.address;
    }

    getRpcHeightData(): Map<string, RpcHeightData> {
        return this.rpcHeightData;
    }
}

export default SteemApiClient; 