import logger from '../logger.js';
import { toBigInt } from './bigint-utils.js';

// Helper to transform numeric string fields in a transaction's data object
export const transformTransactionData = (txData: any): any => {
    if (!txData) return txData;
    const transformedData = { ...txData };
    // Comprehensive list of fields that might need transformation across various transaction types
    const numericFields = [
        'amount', 'fee', 'maxSupply', 'initialSupply', 'currentSupply', 'value', 
        'ask', 'bid', 'price', 'quantity', 'volume', 'low', 'high', 'open', 'close', // market orders/data
        'goal', 'raisedAmount', 'amountContributed', 'tokensAllocated', // launchpad
        'totalStaked', 'rewardRate', 'stakedAmount', 'rewardsEarned', // farms
        'mintPrice', 'royaltyFeeAmount', 'startingPrice', 'currentPrice', 'endingPrice' // NFTs
        // Add other known numeric string fields from various tx data payloads as identified
    ]; 

    for (const field of numericFields) {
        if (transformedData[field] && typeof transformedData[field] === 'string') {
            try {
                transformedData[field] = toBigInt(transformedData[field] as string).toString();
            } catch (e) {
                // Log silently or with lower severity if some fields are expected to not be bigints
                logger.debug(`Failed to transform field ${field} in transaction data: ${transformedData[field]} - ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // Recursively transform nested structures if known (e.g., orders within a market tx)
    if (transformedData.orders && Array.isArray(transformedData.orders)) { 
        transformedData.orders = transformedData.orders.map((order: any) => transformTransactionData(order));
    }
    // Handle generic params object if it might contain such fields
    if (transformedData.params && typeof transformedData.params === 'object') { 
        transformedData.params = transformTransactionData(transformedData.params); // Recursive call
    }
    // Handle specific nested objects known to contain numeric strings
    if (transformedData.tokenomicsSnapshot && typeof transformedData.tokenomicsSnapshot === 'object') {
        transformedData.tokenomicsSnapshot = transformTransactionData(transformedData.tokenomicsSnapshot);
    }
    if (transformedData.presale && typeof transformedData.presale === 'object') {
        transformedData.presale = transformTransactionData(transformedData.presale);
        if (transformedData.presale.participants && Array.isArray(transformedData.presale.participants)) {
            transformedData.presale.participants = transformedData.presale.participants.map((p:any) => transformTransactionData(p));
        }
    }

    return transformedData;
}; 